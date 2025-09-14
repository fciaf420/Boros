# Boros

Python utilities for fetching market APR data from the Pendle Boros Telegram bot using automated user session interactions.

## Features

### Data Collection
- 📊 **Multi-Exchange Support**: Fetches data from 6 markets across Binance and Hyperliquid
- 🤖 **Automated Navigation**: Intelligently clicks through Telegram bot inline keyboards
- 📈 **Spread Analysis**: Calculates spreads and identifies LONG/SHORT trading opportunities
- 💾 **JSON Output**: Structured data with unique market identification
- 🛡️ **Error Handling**: Robust navigation with retry logic and Unicode support

### Strategy Bot
- 🎯 **Single-Position Focus**: Global ranking system selects only the best opportunity across all markets
- 📋 **Dual Strategy Support**: Implied APR Bands + Simple Directional with settlement-aware thresholds
- ⚡ **Settlement-Aware**: Exchange-specific thresholds (Hyperliquid hourly vs Binance 8-hour)
- 🔔 **Discord Integration**: Rich embed alerts with market identification and detailed info
- 🚫 **Conflict Prevention**: Advanced architecture prevents opposing positions on same market
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
3. 📊 Fetch data from all 6 available markets:
   - BTCUSDT Binance 26 Sept 2025
   - ETHUSDT Binance 26 Sept 2025  
   - BTCUSDT Binance 26 Dec 2025
   - ETHUSDT Binance 26 Dec 2025
   - BTCUSDT Hyperliquid 31 Oct 2025
   - ETHUSDT Hyperliquid 31 Oct 2025
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
2. 🎯 **Global ranking analysis** across all 6 markets using 2 strategies:
   - **Implied APR Bands**: Long when APR ≤6%, Short when APR ≥8% (target bands: 6.8-7%)
   - **Simple Directional**: Settlement-aware thresholds (Hyperliquid: 0.7%/0.1%, Binance: 0.5%/0.2%)
3. 🏆 **Best opportunity selection**: Only the highest APY opportunity across all markets gets selected
4. 🚨 **Single alert system**: Maximum 1 active position out of 12 possible positions
5. ⏰ **Smart cooldowns** prevent alert spam (30-minute default)

### Sample Output

**Console Output:**
```
--- BTCUSDT (Binance 26 Sept 2025) Analysis ---
[SUCCESS] Fetched BTCUSDT: Implied 7.29% | Underlying 10.02%
Boros Implied APR: 7.29%
Spread: 2.73%
✓ simple_directional: LONG 2.73% APY

🏆 GLOBAL RANKING & CONFLICT RESOLUTION 🏆
Found 5 qualifying opportunities
🏆 BEST OPPORTUNITY: LONG BTCUSDT (Binance) - 2.73% APY
```

**JSON Output (`rates.json`):**
```json
{
  "generated_at": "2025-09-14T23:05:23.955774+00:00",
  "markets": [
    {
      "market": "BTCUSDT",
      "implied": 7.16,
      "underlying": 8.05,
      "days": null,
      "spread": 0.89,
      "spread_bps": 89.0,
      "raw": "📌 Market info\n\nBTCUSDT Binance 26 Sept 2025...",
      "exchange": "Binance",
      "maturity": "26 Sept 2025",
      "unique_id": "BTCUSDT_BINANCE_SEP_2025"
    }
  ]
}
```

**Strategy Bot Output:**
```
🤖 Strategy Alert Bot initialized
📊 Monitoring: rates.json
🔄 Data refresh: 1800s
📈 Min expected move: 0.5%

🚨 SENDING ALERT: SHORT ETHUSDT (Hyperliquid) - 18.64%

🚨 TRADING OPPORTUNITY ALERT 🚨
⏰ Time: 2025-09-14 14:42:14
📊 Market: ETHUSDT (Hyperliquid 31 Oct 2025)
🎯 Strategy: Implied Apr Bands
==================================================
📊 Implied APR Band Trading (@DDangleDan's Strategy)
   Current APR: 11.46% | Target: 6.80% | Expected Move: 4.66%
🔴 TRADING PLAN: GO SHORT YU
   📍 ENTRY: APR is high (11.46%) - SELL YU now
   📍 EXIT: Cover when APR drops to ~6.80%
   📍 DCA SCALING: Add 25% more every +25bps move against you (max 3 adds)
==================================================
💰 Expected APY: 18.64%
⚖️ Risk Score: 0.60/1.0
💵 Max Position: $30,000
🔧 Leverage: 1.0x

🎯 Sent the best opportunity!
```

## Advanced Architecture

### Single-Position Global Ranking
The system evaluates **all opportunities across all markets simultaneously** and selects only the **highest APY opportunity**:
- **12 Total Positions**: 2 strategies × 6 markets = 12 possible positions
- **1 Active Position**: Only the best opportunity is selected at any time
- **No Conflicts**: Impossible to have opposing strategies on the same market
- **Dynamic Switching**: When current position exits, all opportunities compete again

### Settlement-Aware Thresholds
Different exchanges have different funding settlement frequencies:
- **Hyperliquid (Hourly)**: Tighter thresholds due to 8x more frequent settlements
  - Entry: 0.7% minimum spread (vs 0.5% for Binance)
  - Exit: 0.1% threshold (vs 0.2% for Binance)
- **Binance (8-hour)**: Standard thresholds with more time for spreads to reverse

### Position State Management
Positions are tracked with unique identifiers:
```json
{
  "APR_BANDS:ETHUSDT_HYPERLIQUID_OCT_2025": "SHORT",
  "SIMPLE_DIRECTIONAL:BTCUSDT_BINANCE_SEP_2025": "NONE"
}
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
- **📊 Simple Directional**: Settlement-aware spread trading
  - **Hyperliquid**: Entry ≥0.7%, Exit ≤0.1%
  - **Binance**: Entry ≥0.5%, Exit ≤0.2%

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
├── telethon_rates.py         # Data collection script (6 markets)
├── strategy_bot.py           # Single-position global ranking bot
├── strats.py                # Settlement-aware strategy framework
├── discover_markets.py       # Market discovery utility
├── .env                      # Your credentials (keep private!)
├── .env.example             # Template for configuration
├── requirements.txt          # Python dependencies
├── rates.json               # Market data with unique IDs (generated)
├── positions_state.json     # Active position tracking (generated)
├── discovered_markets.txt   # Market discovery results (generated)
├── user_session.session     # Auth session (auto-generated)
└── CLAUDE.md                # Developer documentation
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

