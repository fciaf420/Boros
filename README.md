# Boros

Python utilities for fetching market APRs from Telegram bots using a user session.

## Setup

1. Copy `.env.example` to `.env` and fill in your Telegram credentials and the `TARGET_BOT` (the bot you want to scrape). Leave `ALERT_BOT_TOKEN` and `ALERT_CHAT_ID` empty if you only want JSON output.
2. Install dependencies with `pip install -r requirements.txt`.
3. Run the script with `python telethon_rates.py`.

The script logs in as a Telegram user, clicks inline buttons for specified markets, parses implied and underlying APRs, computes the spread, and writes results to `OUTPUT_JSON` (default `rates.json`). If `ALERT_BOT_TOKEN` and `ALERT_CHAT_ID` are set, it also sends human-readable alerts via Telegram; otherwise alerts are printed to the console only.

