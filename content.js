(() => {
  "use strict";

  // This content script is intentionally self-contained so the extension can be
  // loaded as a minimal MV3 project without any background/service worker.

  const EXTENSION_ROOT_ID = "fbgs-root";
  const PANEL_ID = "fbgs-panel";
  const BUTTON_ID = "fbgs-button";
  const STATUS_ID = "fbgs-status";

  // Extra runtime guard: the manifest already scopes us to group pages, but
  // Facebook is full of client-side navigation, so we re-check the URL before
  // injecting UI or touching the DOM.
  const isSupportedPage = () =>
    /^https:\/\/www\.facebook\.com\/groups\/.+/i.test(window.location.href);

  if (!isSupportedPage()) {
    return;
  }

  // Prevent duplicate UI injection when Facebook swaps content in-place or if
  // the extension reloads while the tab is still open.
  if (document.getElementById(EXTENSION_ROOT_ID)) {
    return;
  }

  const state = {
    isRunning: false,
    startedAt: 0,
    stopAt: 0,
    countdownTimerId: null,
    nextPostId: 1,
    uniqueKeys: new Set(),
    posts: []
  };

  const randomInt = (min, max) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

  const sleep = (ms) =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });

  const setStatus = (message) => {
    const statusEl = document.getElementById(STATUS_ID);

    if (statusEl) {
      statusEl.textContent = message;
    }
  };

  const updateButton = (label, disabled) => {
    const buttonEl = document.getElementById(BUTTON_ID);

    if (buttonEl) {
      buttonEl.textContent = label;
      buttonEl.disabled = disabled;
    }
  };

  const resetRunState = () => {
    state.isRunning = false;
    state.startedAt = 0;
    state.stopAt = 0;
    state.countdownTimerId = null;
    state.nextPostId = 1;
    state.uniqueKeys = new Set();
    state.posts = [];
  };

  const startCountdown = () => {
    // Keep the panel visibly alive while scraping so we can tell at a glance
    // how long remains and how many unique posts have been captured.
    if (state.countdownTimerId) {
      window.clearInterval(state.countdownTimerId);
    }

    state.countdownTimerId = window.setInterval(() => {
      if (!state.isRunning) {
        window.clearInterval(state.countdownTimerId);
        state.countdownTimerId = null;
        return;
      }

      const remainingMs = Math.max(0, state.stopAt - Date.now());
      const remainingSeconds = Math.ceil(remainingMs / 1000);

      setStatus(
        `Scraper active\nTime left: ${remainingSeconds}s\nUnique posts: ${state.posts.length}`
      );
    }, 250);
  };

  const triggerDownload = (posts, meta) => {
    const output = { meta, posts };
    const json = JSON.stringify(output, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const blobUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement("a");

    // Embed a timestamp in the filename so repeated runs don't overwrite each other.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    downloadLink.href = blobUrl;
    downloadLink.download = `group_data_${stamp}.json`;
    downloadLink.style.display = "none";

    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();

    window.setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 1000);
  };

  const buildFallbackKey = (postUrl, postText, metricsRaw, visibleComments) => {
    // URL is the preferred identifier, but some group feed items do not expose a
    // stable permalink until they are interacted with. This fallback combines
    // multiple visible signals so we can still avoid duplicates across scrolls.
    const fallbackChunks = [
      postUrl || "",
      postText || "",
      metricsRaw || "",
      ...(Array.isArray(visibleComments) ? visibleComments : [])
    ];

    return fallbackChunks
      .join(" || ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const normalizeText = (value) =>
    (value || "")
      .replace(/\s+/g, " ")
      .trim();

  const uniqueNonEmptyTexts = (values) => {
    const seen = new Set();

    return values.filter((value) => {
      const normalized = normalizeText(value);

      if (!normalized || seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      return true;
    });
  };

  const getLeafAutoTexts = (root) => {
    if (!root) {
      return [];
    }

    const autoNodes = Array.from(root.querySelectorAll('div[dir="auto"], span[dir="auto"]'));

    return uniqueNonEmptyTexts(
      autoNodes
        .filter((node) => {
          const childAutoNode = node.querySelector('div[dir="auto"], span[dir="auto"]');
          return !childAutoNode;
        })
        .map((node) => node.innerText || node.textContent || "")
    );
  };

  const pickBestTextCandidate = (values) => {
    const candidates = uniqueNonEmptyTexts(values);

    if (candidates.length === 0) {
      return null;
    }

    return [...candidates].sort((left, right) => right.length - left.length)[0];
  };

  const extractExactPostText = (article) => {
    const exactSelectors = [
      // Most specific: the leaf text div Facebook adds an inline text-align style to.
      '[data-ad-comet-preview="message"] div[dir="auto"][style*="text-align"]',
      '[data-ad-preview="message"] div[dir="auto"][style*="text-align"]',
      '[data-ad-rendering-role="story_message"] div[dir="auto"][style*="text-align"]',
      // Broader fallbacks that still scope to the message area.
      '[data-ad-rendering-role="story_message"] div[dir="auto"]',
      '[data-ad-rendering-role="story_message"] span[dir="auto"]',
      'span[data-ad-rendering-role="description"]',
      '[data-ad-preview="message"] div[dir="auto"]',
      '[data-ad-comet-preview="message"] div[dir="auto"]'
    ];

    const exactTexts = exactSelectors.flatMap((selector) =>
      Array.from(article.querySelectorAll(selector)).map(
        (node) => node.innerText || node.textContent || ""
      )
    );

    return pickBestTextCandidate(exactTexts);
  };

  // Strip tracking query params and comment anchors from a Facebook URL so we
  // store only the clean canonical path (e.g. /groups/X/posts/Y/).
  const cleanFacebookUrl = (raw) => {
    if (!raw) {
      return null;
    }

    try {
      const u = new URL(raw);
      return u.origin + u.pathname.replace(/\/$/, "") + "/";
    } catch (_) {
      return raw.split("?")[0].split("#")[0] || null;
    }
  };

  const extractPostUrl = (article) => {
    let postUrl = null;

    try {
      const anchors = Array.from(article.querySelectorAll("a[href]"));

      // Prefer stable post permalink/posts URLs over any other link.
      const postAnchor = anchors.find((anchor) => {
        const href = anchor.getAttribute("href") || "";
        return (
          href.includes("/groups/") &&
          (href.includes("/permalink/") || href.includes("/posts/"))
        );
      }) || null;

      if (postAnchor) {
        postUrl = cleanFacebookUrl(
          postAnchor.href || postAnchor.getAttribute("href")
        );
      }
    } catch (error) {
      console.debug("fb-group-scraper: failed to extract post URL", error);
    }

    return postUrl || null;
  };

  // Returns true if a short string looks like a relative or absolute timestamp
  // ("10h", "2d", "March 5", "Yesterday", "Just now", etc.).
  const looksLikeTimestamp = (text) => {
    if (!text || text.length > 30) return false;
    return (
      /^\d+\s*(m|h|d|w|min|hr|hrs|days?)$/i.test(text) ||
      /^(just now|yesterday|today)/i.test(text) ||
      /^[A-Z][a-z]+ \d{1,2}(, \d{4})?$/.test(text) || // "March 5" or "March 5, 2025"
      /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(text)    // "3/5" or "3/5/25"
    );
  };

  // Extract when the post was published. Facebook places a timestamp link
  // (showing "10h", "March 5", etc.) near the author in the post header.
  const extractPostTimestamp = (article) => {
    try {
      // Prefer <abbr title="full date"> which Facebook sometimes uses.
      const abbr = article.querySelector(
        ':not([role="article"]) abbr[title]'
      );
      if (abbr) {
        return abbr.getAttribute("title") || abbr.textContent?.trim() || null;
      }

      // Fallback: find a <a> or <span> near the author header that has timestamp text.
      // Exclude anything inside a nested comment article.
      const commentArticles = Array.from(
        article.querySelectorAll('[role="article"]')
      );
      const isInComment = (el) => commentArticles.some((c) => c.contains(el));

      const candidates = Array.from(
        article.querySelectorAll("a, span")
      ).filter((el) => !isInComment(el));

      for (const el of candidates) {
        const text = (el.textContent || "").trim();
        if (looksLikeTimestamp(text)) {
          // Prefer the title/aria-label if present (it holds the full date).
          return (
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            text
          );
        }
      }
    } catch (error) {
      console.debug("fb-group-scraper: failed to extract post timestamp", error);
    }

    return null;
  };

  // Extract the post author name from the profile_name rendering role.
  const extractAuthorName = (article) => {
    const profileEl = article.querySelector(
      '[data-ad-rendering-role="profile_name"]'
    );

    if (!profileEl) {
      return null;
    }

    // The h3 inside profile_name is the most reliable text node for the name.
    const h3 = profileEl.querySelector("h3");
    const raw = h3
      ? h3.innerText || h3.textContent || ""
      : profileEl.innerText || profileEl.textContent || "";

    // Strip role suffixes like "· Follow", "· Moderator", "· Admin" that
    // Facebook appends to the name in the same text node.
    return normalizeText(raw).split(" · ")[0].trim() || null;
  };

  // UI strings that appear in the feed but are not comments.
  const UI_CHROME = new Set([
    "like", "comment", "send", "share", "reply", "follow",
    "moderator", "view insights", "view more answers", "view more comments",
    "likecommentsend", "likecommentsendsharereply",
  ]);

  const isUiChrome = (text) => {
    const lower = text.toLowerCase();
    if (UI_CHROME.has(lower)) return true;
    if (/^\d[\d,.]* post reach$/.test(text)) return true;
    if (/^\d[\d,.]* comments?$/.test(text)) return true;
    if (/^\d[\d,.]* reactions?$/.test(text)) return true;
    if (/^view \d+ repl/i.test(text)) return true;
    if (/^answer as /i.test(text)) return true;
    if (/^comment as /i.test(text)) return true;
    return false;
  };

  // Extract visible comments from within a post article.
  // Returns an array of { author, time, text } objects.
  // Facebook renders each comment as a nested role="article" element. Comments
  // do NOT have a story_message descendant (that only appears in posts).
  const extractComments = (article) => {
    const commentEls = Array.from(
      article.querySelectorAll('[role="article"]')
    ).filter(
      (el) => !el.querySelector('[data-ad-rendering-role="story_message"]')
    );

    if (commentEls.length > 0) {
      return commentEls
        .map((el) => {
          // --- author ---
          const profileEl = el.querySelector(
            '[data-ad-rendering-role="profile_name"]'
          );
          let author = normalizeText(
            profileEl ? profileEl.innerText || profileEl.textContent || "" : ""
          ).split(" · ")[0].trim();

          // Parse aria-label as backup: "Comment by TravelTico6915 · 10h"
          const ariaLabel = el.getAttribute("aria-label") || "";
          if (!author) {
            const m = ariaLabel.match(/^[^·]+by\s+(.+?)(?:\s+·|\s*$)/i);
            if (m) author = m[1].trim();
          }

          // --- time ---
          // Try parsing from aria-label first ("... · 10h"), then scan child elements.
          let time = null;
          const ariaTimePart = ariaLabel.split(" · ").slice(1).find(looksLikeTimestamp);
          if (ariaTimePart) {
            time = ariaTimePart.trim();
          } else {
            const timeEl = Array.from(el.querySelectorAll("a, span, abbr")).find(
              (node) => looksLikeTimestamp((node.textContent || "").trim())
            );
            if (timeEl) {
              time =
                timeEl.getAttribute("aria-label") ||
                timeEl.getAttribute("title") ||
                (timeEl.textContent || "").trim();
            }
          }

          // --- text ---
          const textNodes = Array.from(
            el.querySelectorAll('div[dir="auto"], span[dir="auto"]')
          ).filter(
            (node) =>
              !node.querySelector('div[dir="auto"], span[dir="auto"]') &&
              !node.closest('[data-ad-rendering-role="profile_name"]')
          );

          const text = normalizeText(
            textNodes.map((n) => n.innerText || n.textContent || "").join(" ")
          );

          if (!text || isUiChrome(text)) {
            return null;
          }

          return { author: author || null, time: time || null, text };
        })
        .filter(Boolean);
    }

    // Fallback: generic leaf dir="auto" nodes outside the post body, returned
    // as plain { text } objects (no author/time available in this path).
    return uniqueNonEmptyTexts(
      Array.from(
        article.querySelectorAll('div[dir="auto"], span[dir="auto"]')
      )
        .filter(
          (node) =>
            !node.querySelector('div[dir="auto"], span[dir="auto"]') &&
            !node.closest('[data-ad-rendering-role="story_message"]') &&
            !node.closest('[data-ad-preview="message"]') &&
            !node.closest('[data-ad-comet-preview="message"]')
        )
        .map((node) => node.innerText || node.textContent || "")
    )
      .filter((text) => !isUiChrome(text))
      .map((text) => ({ author: null, time: null, text }));
  };

  // Return true for single-word platform strings that are never real post text.
  const isNoisyText = (text) =>
    !text ||
    text === "Facebook" ||
    text === "Instagram" ||
    text === "Messenger" ||
    text.length < 3;

  // Find all leaf dir="auto" nodes within article that are NOT inside any
  // nested comment article. Used as a broad fallback for post text.
  const getPostBodyLeafTexts = (article) => {
    const commentArticles = Array.from(
      article.querySelectorAll('[role="article"]')
    );

    return uniqueNonEmptyTexts(
      Array.from(
        article.querySelectorAll('div[dir="auto"], span[dir="auto"]')
      )
        .filter((node) => {
          if (node.querySelector('div[dir="auto"], span[dir="auto"]')) {
            return false;
          }
          // Exclude nodes that sit inside a nested comment article.
          for (const c of commentArticles) {
            if (c.contains(node)) return false;
          }
          return true;
        })
        .map((node) => node.innerText || node.textContent || "")
    ).filter((t) => !isNoisyText(t) && !isUiChrome(t));
  };

  const extractPostTextAndComments = (article) => {
    let postText = null;
    let visibleComments = [];

    try {
      postText = extractExactPostText(article);

      // If the story_message selectors returned platform noise ("Facebook" etc.)
      // or nothing, attempt more targeted fallbacks.
      if (!postText || isNoisyText(postText)) {
        const messageRoots = [
          '[data-ad-rendering-role="story_message"]',
          '[data-ad-preview="message"]',
          '[data-ad-comet-preview="message"]',
          '[data-ad-rendering-role="description"]'
        ];

        const candidates = uniqueNonEmptyTexts(
          messageRoots.flatMap((selector) =>
            Array.from(article.querySelectorAll(selector)).flatMap((node) =>
              getLeafAutoTexts(node)
            )
          )
        ).filter((t) => !isNoisyText(t));

        postText = pickBestTextCandidate(candidates) || null;
      }

      // Broad fallback: scan the whole post body (excluding comment sub-articles)
      // for the longest meaningful text block. This catches posts where the text
      // lives outside the story_message container.
      if (!postText || isNoisyText(postText)) {
        postText = pickBestTextCandidate(getPostBodyLeafTexts(article)) || null;
      }

      visibleComments = extractComments(article).filter((c) => {
        const n = normalizeText(c.text);
        return n !== normalizeText(postText || "") && n.length > 0;
      });
    } catch (error) {
      console.debug("fb-group-scraper: failed to extract text/comments", error);
    }

    return {
      postText,
      visibleComments
    };
  };

  const extractMetricsRaw = (article) => {
    let metricsRaw = null;

    try {
      // First preference: Facebook often collects reaction/comment/share controls
      // under a toolbar region.
      const toolbar = article.querySelector('[role="toolbar"]');

      if (toolbar?.innerText?.trim()) {
        metricsRaw = toolbar.innerText.trim();
      }
    } catch (error) {
      console.debug("fb-group-scraper: failed to extract toolbar metrics", error);
    }

    if (metricsRaw) {
      return metricsRaw;
    }

    try {
      // Collect short text nodes that look like engagement counts.
      // We limit to short strings (≤ 40 chars) to avoid grabbing post/comment text.
      const commentArticles = Array.from(
        article.querySelectorAll('[role="article"]')
      );

      const isInsideComment = (node) =>
        commentArticles.some((c) => c.contains(node));

      const countParts = Array.from(article.querySelectorAll("span, a"))
        .filter((el) => !isInsideComment(el))
        .map((el) => (el.textContent || "").trim())
        .filter((text) => {
          if (!text || text.length > 40) return false;
          return (
            /\d/.test(text) &&
            (/post reach/i.test(text) ||
              /comments?/i.test(text) ||
              /reactions?/i.test(text) ||
              /shares?/i.test(text) ||
              /comentarios?/i.test(text) ||
              /me gusta/i.test(text))
          );
        });

      if (countParts.length > 0) {
        metricsRaw = [...new Set(countParts)].join(" · ");
      }
    } catch (error) {
      console.debug("fb-group-scraper: failed to extract count metrics", error);
    }

    return metricsRaw || null;
  };

  const getFeedRoot = () => {
    return (
      document.querySelector('div[role="feed"]') ||
      document.querySelector('[aria-label="Group content"] div[role="feed"]') ||
      null
    );
  };

  // Find the top-level post roots in the feed.
  //
  // Facebook has shipped several feed layouts over time:
  //   1. Classic:  each post wrapped in role="article"
  //   2. Modern:   posts wrapped in data-virtualized="false|true" divs;
  //                role="article" and role="feed" are absent
  //   3. Fallback: locate story_message elements and treat their closest
  //                reasonable ancestor as the post root
  const findPostRoots = (scope) => {
    // --- Strategy 1: role="article" (classic layout) ---
    // Facebook uses role="article" for BOTH posts AND comments. Posts always
    // have a story_message descendant; comments never do. Filter to posts only,
    // and skip any article nested inside another article (comment threads).
    const roleArticles = Array.from(
      scope.querySelectorAll('[role="article"]')
    ).filter(
      (article) =>
        !!article.querySelector('[data-ad-rendering-role="story_message"]') &&
        !article.parentElement?.closest('[role="article"]')
    );

    if (roleArticles.length > 0) {
      return roleArticles;
    }

    // --- Strategy 2: data-virtualized (modern layout) ---
    // Facebook's feed renderer wraps each post in a div[data-virtualized].
    // Keep only outermost containers (skip any nested data-virtualized divs)
    // and require the container to actually hold a post body.
    const virtualized = Array.from(
      scope.querySelectorAll('[data-virtualized]')
    ).filter(
      (el) =>
        el.querySelector('[data-ad-rendering-role="story_message"]') &&
        !el.parentElement?.closest('[data-virtualized]')
    );

    if (virtualized.length > 0) {
      return virtualized;
    }

    // --- Strategy 3: walk up from story_message elements ---
    // If neither of the above selectors matched, find each story_message and
    // use its ancestor 8 levels up as the post root. This is the broadest
    // fallback and guarantees we still capture something.
    const storyMessages = Array.from(
      scope.querySelectorAll('[data-ad-rendering-role="story_message"]')
    );

    const seen = new Set();
    const roots = [];

    storyMessages.forEach((el) => {
      let current = el;

      for (
        let steps = 0;
        steps < 8 && current.parentElement && current.parentElement !== document.body;
        steps += 1
      ) {
        current = current.parentElement;
      }

      if (!seen.has(current)) {
        seen.add(current);
        roots.push(current);
      }
    });

    return roots;
  };

  const scrapeVisiblePosts = () => {
    const feedRoot = getFeedRoot();
    const scope = feedRoot || document;
    const articles = findPostRoots(scope);

    articles.forEach((article) => {
      let postUrl = null;
      let authorName = null;
      let postTimestamp = null;
      let postText = null;
      let metrics = null;
      let comments = [];

      try {
        postUrl = extractPostUrl(article);
      } catch (error) {
        console.debug("fb-group-scraper: URL extraction wrapper failed", error);
      }

      try {
        authorName = extractAuthorName(article);
      } catch (error) {
        console.debug("fb-group-scraper: author extraction wrapper failed", error);
      }

      try {
        postTimestamp = extractPostTimestamp(article);
      } catch (error) {
        console.debug("fb-group-scraper: timestamp extraction wrapper failed", error);
      }

      try {
        const textData = extractPostTextAndComments(article);
        postText = textData.postText;
        comments = textData.visibleComments;
      } catch (error) {
        console.debug("fb-group-scraper: text extraction wrapper failed", error);
      }

      try {
        metrics = extractMetricsRaw(article);
      } catch (error) {
        console.debug("fb-group-scraper: metrics extraction wrapper failed", error);
      }

      const uniqueKey =
        postUrl || buildFallbackKey(postUrl, postText, metrics, comments.map((c) => c.text));

      // Skip items that are completely empty or already seen during previous
      // loop passes.
      if (!uniqueKey || state.uniqueKeys.has(uniqueKey)) {
        return;
      }

      state.uniqueKeys.add(uniqueKey);
      state.posts.push({
        id: state.nextPostId++,
        url: postUrl,
        author: authorName,
        posted_at: postTimestamp,
        post_text: postText,
        metrics,
        comments
      });
    });
  };

  const simulateHumanScroll = async () => {
    // Facebook's feed loader is happier when scrolling happens in chunks rather
    // than a single abrupt jump, so we do a few stepped moves before nudging all
    // the way to the current page bottom.
    const stepCount = randomInt(2, 4);

    for (let index = 0; index < stepCount; index += 1) {
      const chunk = randomInt(350, 900);
      window.scrollBy({
        top: chunk,
        left: 0,
        behavior: "smooth"
      });
      await sleep(randomInt(250, 500));
    }

    // We also dispatch an End key event as a cheap "human-like" signal because
    // some lazy-loading listeners respond to keyboard navigation as well.
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "End",
          code: "End",
          keyCode: 35,
          which: 35,
          bubbles: true
        })
      );
    } catch (error) {
      console.debug("fb-group-scraper: End key simulation failed", error);
    }

    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "smooth"
    });
  };

  const runScrapeLoop = async () => {
    while (state.isRunning && Date.now() < state.stopAt) {
      scrapeVisiblePosts();
      await simulateHumanScroll();

      const waitMs = randomInt(3000, 6000);
      await sleep(waitMs);
    }
  };

  const finalizeRun = () => {
    if (state.countdownTimerId) {
      window.clearInterval(state.countdownTimerId);
      state.countdownTimerId = null;
    }

    const finalPosts = [...state.posts];

    const meta = {
      generated_at: new Date().toISOString(),
      page_url: window.location.href,
      page_title: document.title || null,
      post_count: finalPosts.length,
      scraper_version: "1.0.0"
    };

    updateButton("Start Scraping", false);
    setStatus(`Finished\nExported ${finalPosts.length} unique posts`);

    triggerDownload(finalPosts, meta);
    resetRunState();
  };

  const startScraping = async () => {
    if (state.isRunning || !isSupportedPage()) {
      return;
    }

    resetRunState();

    state.isRunning = true;
    state.startedAt = Date.now();
    state.stopAt = state.startedAt + randomInt(10_000, 20_000);

    updateButton("Scraping...", true);
    startCountdown();

    try {
      await runScrapeLoop();
    } catch (error) {
      console.error("fb-group-scraper: scrape loop failed", error);
      setStatus("Stopped early due to an unexpected error");
    } finally {
      finalizeRun();
    }
  };

  const injectUi = () => {
    const root = document.createElement("div");
    root.id = EXTENSION_ROOT_ID;

    root.innerHTML = `
      <div id="${PANEL_ID}">
        <button id="${BUTTON_ID}" type="button">Start Scraping</button>
        <div id="${STATUS_ID}">Ready on Facebook Group page</div>
      </div>
    `;

    document.documentElement.appendChild(root);

    const button = document.getElementById(BUTTON_ID);

    if (button) {
      button.addEventListener("click", () => {
        void startScraping();
      });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectUi, { once: true });
  } else {
    injectUi();
  }
})();
