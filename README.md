# Boros

Python utilities for fetching market APR data from the Pendle Boros Telegram bot using automated user session interactions.

## Features

### Data Collection
- 📊 **Market Data Extraction**: Fetches Implied and Underlying APR rates from all available Pendle markets
- 🤖 **Automated Navigation**: Intelligently clicks through Telegram bot inline keyboards
- 📈 **Spread Analysis**: Calculates spreads and identifies LONG/SHORT trading opportunities
- 💾 **JSON Output**: Structured data export for further analysis
- 🛡️ **Error Handling**: Robust navigation with retry logic and Unicode support

### Strategy Bot
- 🎯 **Automated Strategy Detection**: Monitors rates and alerts on trading opportunities
- 📋 **Multiple Strategies**: Supports Implied APR Bands and Fixed/Floating Swaps
- 🔔 **Discord Integration**: Rich embed alerts with color coding and detailed info
- ⚙️ **Configurable Intervals**: Environment-controlled data refresh timing
- 🚨 **Smart Alerting**: Cooldown periods to prevent spam notifications
- 🔄 **Automatic Data Refresh**: Fetches fresh data from Telegram periodically

## Prerequisites

Before you begin, you'll need:
- Python 3.7+
- A Telegram account
- Access to the Pendle Boros bot (`@boros_pendle_bot`)

## Step-by-Step Setup

### 1. Get Telegram API Credentials

1. **Visit Telegram's Developer Portal**:
   - Go to [https://my.telegram.org](https://my.telegram.org)
   - Sign in with your phone number (same number you use for Telegram)

2. **Create an Application**:
   - Click "API development tools"
   - Fill out the form:
     - **App title**: `Boros APR Scraper` (or any name)
     - **Short name**: `boros-scraper`
     - **Platform**: Choose "Other"
     - **Description**: `Market data collection for Pendle`
   - Click "Create application"

3. **Save Your Credentials**:
   - Copy your `api_id` (numeric)
   - Copy your `api_hash` (long hexadecimal string)
   - Keep these secure - treat them like passwords!

### 2. Install Dependencies

```bash
# Clone or download this repository
git clone <repository-url>
cd Boros

# Install required Python packages
pip install -r requirements.txt
```

### 3. Configure Environment

1. **Copy the environment template**:
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` file** with your credentials:
   ```env
   # Telegram API Configuration
   TG_API_ID=1234567                                    # Your numeric API ID
   TG_API_HASH=abcdef0123456789abcdef0123456789          # Your API hash
   TG_PHONE=+1234567890                                 # Your phone number with country code
   TARGET_BOT=@boros_pendle_bot                         # The Pendle Boros bot username
   
   # Basic Alert Configuration (Optional)
   ALERT_BOT_TOKEN=                                     # (Optional) Bot token for alerts
   ALERT_CHAT_ID=                                       # (Optional) Chat ID for alerts  
   OUTPUT_JSON=rates.json                               # Output file name
   
   # Strategy Bot Configuration
   DATA_REFRESH_INTERVAL_SECONDS=1800                   # Data refresh interval (30 minutes default)
   DISCORD_WEBHOOK_URL=                                 # (Optional) Discord webhook for strategy alerts
   ```

### 4. First Run & Authentication

1. **Run the script**:
   ```bash
   python telethon_rates.py
   ```

2. **Complete Authentication**:
   - The script will prompt: `Enter the login code:`
   - Check your Telegram app for a login code
   - Enter the 5-digit code when prompted
   - A session file (`user_session.session`) will be created for future runs

### 5. Set Up Optional Alerts (Recommended)

To receive trading alerts via Telegram:

1. **Create a Bot**:
   - Message [@BotFather](https://t.me/botfather) on Telegram
   - Send `/newbot` and follow the prompts
   - Save the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

2. **Get Your Chat ID**:
   - Start a chat with your new bot
   - Send any message to the bot
   - Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Look for `"chat":{"id":123456789}` in the response
   - Save this chat ID

3. **Update `.env`**:
   ```env
   ALERT_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   ALERT_CHAT_ID=123456789
   ```

### 6. Set Up Discord Alerts (Strategy Bot)

To receive strategy alerts via Discord webhook:

1. **Create a Discord Webhook**:
   - Go to your Discord server settings
   - Navigate to "Integrations" → "Webhooks"
   - Click "New Webhook" or "Create Webhook"
   - Choose the channel for alerts
   - Copy the webhook URL

2. **Update `.env`**:
   ```env
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1234567890/your-webhook-token
   ```

## Usage

### Data Collection (Manual)

```bash
python telethon_rates.py
```

The script will:
1. 🔐 Authenticate with Telegram (first run only)
2. 🤖 Navigate to the Boros bot
3. 📊 Fetch data from all 4 available markets:
   - BTCUSDT Binance 26 Sept 2025
   - ETHUSDT Binance 26 Sept 2025  
   - BTCUSDT Binance 26 Dec 2025
   - ETHUSDT Binance 26 Dec 2025
4. 📈 Calculate spreads and identify opportunities
5. 💾 Save results to `rates.json`
6. 🔔 Send alerts (if configured)

### Strategy Bot (Automated)

```bash
# Run the strategy bot continuously
python strategy_bot.py

# Test with current data (single analysis)
python strategy_bot.py test
```

The strategy bot will:
1. 🔄 **Auto-refresh data** every 30 minutes (configurable via `DATA_REFRESH_INTERVAL_SECONDS`)
2. 🎯 **Analyze strategies** after each data refresh:
   - **Implied APR Bands**: Long when APR ≤6%, Short when APR ≥8%
   - **Fixed/Floating Swaps**: Alert on spreads ≥10%
3. 🚨 **Send alerts** via console and Discord (if webhook configured)
4. ⏰ **Smart cooldowns** prevent alert spam (30-minute default)

### Sample Output

**Console Output:**
```
--- Processing market 1/4: BTCUSDT Binance 26 Sept 2025 ---
[SUCCESS] Fetched BTCUSDT: Implied 7.29% | Underlying 10.02%

[ALERT] LONG candidate (carry +):
BTCUSDT
Implied: 7.29% | Underlying: 10.02% (Spread: +2.73%)
```

**JSON Output (`rates.json`):**
```json
{
  "generated_at": "2025-09-08T00:03:31.152289+00:00",
  "markets": [
    {
      "market": "BTCUSDT",
      "implied": 7.29,
      "underlying": 10.02,
      "days": null,
      "spread": 2.73,
      "spread_bps": 273.0,
      "raw": "📌 Market info\n\nBTCUSDT Binance 26 Sept 2025..."
    }
  ]
}
```

**Strategy Bot Output:**
```
🤖 Strategy Alert Bot initialized
📊 Monitoring: rates.json
🔄 Data refresh: 1800s
📈 Min expected move: 1.0%

🚨 TRADING OPPORTUNITY ALERT 🚨
⏰ Time: 2025-09-08 15:30:45
📊 Symbol: ETHUSDT
🎯 Strategy: Implied Apr Bands
==================================================
📊 Implied APR Band Trading (@DDangleDan's Strategy)
   Current APR: 5.80%
   Target APR: 6.85%
🟢 RECOMMENDED ACTION: GO LONG YU
   APR is low (5.80%) - BUY YU
   Exit target: ~6.85%
   Expected move: 1.05%
==================================================
💰 Expected APY: 4.20%
⚖️ Risk Score: 0.50/1.0
💵 Max Position: $75,000
🔧 Leverage: 1.0x
```

## Trading Signal Interpretation

### Basic Signals (telethon_rates.py)
- **🟢 LONG Candidate**: Underlying APR > Implied APR (positive spread ≥0.5%)
- **🔴 SHORT Candidate**: Underlying APR < Implied APR (negative spread ≤-0.5%)
- **ℹ️ Neutral**: Spread between -0.5% and +0.5%

### Strategy Bot Signals
- **📊 Implied APR Bands**: Based on @DDangleDan's strategy
  - **Long**: APR ≤6.0% (target: 6.8-7.0%)
  - **Short**: APR ≥8.0% (target: 6.0-6.8%)
- **📊 Fixed/Floating Swaps**: Based on @ViNc2453's arbitrage
  - **Alert**: Spread ≥10% between implied and underlying rates

## Troubleshooting

### Common Issues

**"Could not click button"**: 
- The bot might be temporarily unavailable
- Check that `@boros_pendle_bot` is accessible in your Telegram

**"Failed to parse rates"**:
- Bot response format may have changed
- Check debug files (`debug_*.txt`) for raw responses

**Unicode/Encoding Errors**:
- Should be automatically handled on Windows
- If issues persist, run in a UTF-8 compatible terminal

**Session Expired**:
- Delete `user_session.session` file
- Run script again to re-authenticate

### File Structure
```
Boros/
├── telethon_rates.py      # Data collection script
├── strategy_bot.py        # Automated strategy monitoring bot
├── strats.py             # Trading strategy framework
├── .env                   # Your credentials (keep private!)
├── .env.example          # Template for configuration
├── requirements.txt       # Python dependencies
├── rates.json            # Output data (generated)
├── user_session.session  # Auth session (auto-generated)
└── CLAUDE.md             # Developer documentation
```

## Security Notes

- 🔒 **Never commit `.env`** - it contains your private credentials
- 🔒 **Keep `user_session.session` private** - it contains your auth token
- 🔒 **Treat API credentials like passwords** - don't share them
- 🔒 **The script only reads data** - it doesn't perform any trading operations

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review debug files created in the project directory
3. Ensure all credentials are correctly configured in `.env`

