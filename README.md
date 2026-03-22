# FB Group Scraper

A lightweight, self-contained Chrome Extension (Manifest V3) designed to scrape posts from Facebook Groups. It simulates human-like scrolling behavior to load content and exports the captured data as a clean JSON file.

## Features

- **Human-Like Interaction**: Uses randomized delays and stepped scrolling to mimic natural user behavior.
- **Data Extraction**: Captures key post information:
  - Post URL (clean permalinks)
  - Author Name
  - Timestamp (relative and absolute)
  - Post Text
  - Metrics (Reactions, Comments, Shares, Reach)
  - Visible Comments (Commenter name and text)
- **Duplicate Prevention**: Intelligently tracks unique posts during the scraping session to avoid redundant data.
- **JSON Export**: Automatically downloads a timestamped JSON file containing the scraped data and session metadata.
- **Minimal Footprint**: No background service workers or external dependencies required.

## Installation

1. Clone or download this repository.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle in the top right corner.
4. Click **Load unpacked** and select the directory containing this project.

## Usage

1. Navigate to any Facebook Group page (e.g., `https://www.facebook.com/groups/your-group-name`).
2. A small control panel will appear in the bottom-right corner of the page.
3. Click **Start Scraping**.
4. The scraper will begin scrolling and collecting data. You can monitor the progress (time remaining and unique posts captured) in the status panel.
5. Once the session finishes (after a randomized duration of 10-20 seconds), a JSON file named `group_data_[timestamp].json` will be downloaded automatically.

## Data Schema

The exported JSON file follows this structure:

```json
{
  "meta": {
    "generated_at": "ISO-8601 Timestamp",
    "page_url": "URL of the group",
    "page_title": "Title of the page",
    "post_count": 42,
    "scraper_version": "1.0.0"
  },
  "posts": [
    {
      "id": 1,
      "url": "Canonical post URL",
      "author": "Author Name",
      "posted_at": "Date/Time string",
      "post_text": "Main body text of the post",
      "metrics": "Engagement summary (e.g., '12 Reactions · 5 Comments')",
      "comments": [
        {
          "commenter": "Commenter Name",
          "text": "Comment content"
        }
      ]
    }
  ]
}
```

## Technical Details

- **Manifest V3**: Compliant with the latest Chrome extension standards.
- **Content Script**: `content.js` handles the scraping logic, UI injection, and download triggering.
- **Styles**: `styles.css` provides a modern, dark-themed overlay UI.
- **Compatibility**: Designed for the modern Facebook "Comet" layout, with fallbacks for virtualized feeds and classic structures.

## Disclaimer

This tool is for educational and research purposes only. Please ensure you comply with Facebook's Terms of Service and only use this tool responsibly on data you have permission to access.
