# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Boros is a Python utility for fetching market APR (Annual Percentage Rate) data from Telegram bots using Telethon. It automates the interaction with a specific Telegram bot by clicking inline keyboard buttons for different cryptocurrency markets (BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT), parsing implied and underlying APR data, calculating spreads, and outputting results as both JSON and optional Telegram alerts.

## Development Commands

### Setup and Installation
```bash
# Copy environment template and configure
cp .env.example .env
# Edit .env with your Telegram API credentials and target bot

# Install dependencies
pip install -r requirements.txt
```

### Running the Application
```bash
# Main execution - fetches market data from Telegram bot
python telethon_rates.py
```

The script will:
1. Authenticate with Telegram using your user session
2. Send `/start` to the target bot
3. Click through market buttons (BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT)
4. Parse APR data from bot responses using regex patterns
5. Calculate spreads and generate alerts based on thresholds
6. Save results to `rates.json`

## Architecture

### Core Components

**telethon_rates.py** - Main application file containing:
- `MarketData` dataclass for structured market information
- `parse_rates()` - Regex-based parser for extracting APR values from bot messages
- `fetch_market()` - Async function to interact with bot and retrieve data for a single market
- `alert()` - Optional Telegram notification system
- `main()` - Orchestrates the entire data collection workflow

### Key Configuration

**Environment Variables (.env)**:
- `TG_API_ID`, `TG_API_HASH`, `TG_PHONE` - Telegram API credentials
- `TARGET_BOT` - Username of the bot to scrape (required)
- `ALERT_BOT_TOKEN`, `ALERT_CHAT_ID` - Optional alert bot configuration
- `OUTPUT_JSON` - Output file path (defaults to rates.json)

**Market Configuration**:
- `MARKETS` list defines which cryptocurrency pairs to query
- Spread thresholds: `LONG_SPREAD_BPS = 50`, `SHORT_SPREAD_BPS = -50`
- Regex patterns for parsing: `IMPLIED_RE`, `UNDER_RE`, `DAYS_RE`

### Data Flow

1. **Authentication**: Telethon client authenticates with user session
2. **Bot Interaction**: Sends `/start` and navigates inline keyboard
3. **Data Extraction**: Parses APR data using regex from bot responses
4. **Spread Calculation**: Computes underlying - implied APR spread
5. **Alert Generation**: Classifies as LONG/SHORT/Neutral based on spread thresholds
6. **Output**: Saves structured JSON and sends optional Telegram alerts

### Session Management

The application creates a `user_session.session` file for Telegram authentication persistence. This file should not be committed (already in .gitignore).

### Error Handling

- FloodWaitError handling with automatic retry delays
- Graceful degradation when bot interactions fail
- Optional alert system with console fallback
- Robust message parsing with retry logic