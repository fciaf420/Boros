# Boros

Python utilities for fetching market APRs from Telegram bots using a user session.

## Setup

1. Copy `.env.example` to `.env` and fill in your Telegram credentials and bot info.
2. Install dependencies with `pip install -r requirements.txt`.
3. Run the script with `python telethon_rates.py`.

The script logs in as a Telegram user, clicks inline buttons for specified markets,
parses implied and underlying APRs, computes the spread, and sends alerts through
your own bot.

