# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Boros is a comprehensive trading analysis system for Pendle Boros protocol opportunities. It consists of data collection from Telegram bots and automated strategy analysis with Discord alerting. The system focuses exclusively on on-chain strategies using Boros implied vs underlying APR spreads, avoiding external CEX positions or perpetual trading.

## Development Commands

### Setup and Installation
```bash
# Copy environment template and configure
cp .env.example .env
# Edit .env with your Telegram API credentials and target bot

# Install dependencies
pip install -r requirements.txt
```

### Running Applications
```bash
# Data collection - fetches market data from Telegram bot (manual)
python telethon_rates.py

# Strategy bot - continuous monitoring with automated alerts
python strategy_bot.py

# Strategy bot - single test analysis with current data
python strategy_bot.py test

# Strategy framework - run test scenarios
python strats.py
```

## Architecture Overview

### Three-Layer System Architecture

**Layer 1: Data Collection (`telethon_rates.py`)**
- Automates Telegram bot interaction using Telethon
- Extracts implied/underlying APR data from Pendle Boros bot (`@boros_pendle_bot`)
- Outputs structured JSON with market spreads and timestamps
- Handles authentication, session management, and error recovery

**Layer 2: Strategy Framework (`strats.py`)**
- Multiple trading strategy implementations with risk assessment
- Position state tracking via JSON persistence (`positions_state.json`)
- Strategy evaluation engine with standardized opportunity scoring
- **Active Strategies**: SimpleDirectionalStrategy, ImpliedAPRBandStrategy
- **Inactive Strategies**: FixedFloatingSwapStrategy (requires external CEX positions - excluded)

**Layer 3: Automated Monitoring (`strategy_bot.py`)**
- Continuous monitoring with configurable refresh intervals
- Discord webhook integration for rich trading alerts
- Strategy evaluation and alert filtering with cooldown management
- Position state awareness to prevent entry/exit confusion

### Key Architecture Patterns

**Strategy Pattern Implementation**:
- Each strategy class implements `evaluate_opportunity()` method
- Returns standardized opportunity dictionaries or `None`
- `StrategyManager` coordinates evaluation across multiple strategies
- Risk assessment and position sizing calculated per strategy

**State Management**:
- `positions_state.json` tracks current positions (LONG/SHORT/NONE)
- SimpleDirectionalStrategy uses state to determine entry vs exit logic
- State updates are atomic and immediately persisted
- Prevents duplicate entry signals and ensures proper exit detection

**Data Pipeline**:
```
Telegram Bot → telethon_rates.py → rates.json → strategy_bot.py → Discord Alerts
                                               ↓
                                    StrategyManager → Individual Strategies
                                               ↓
                                    positions_state.json
```

### Critical Configuration

**Environment Variables (.env)**:
- `TG_API_ID`, `TG_API_HASH`, `TG_PHONE` - Telegram API credentials
- `TARGET_BOT=@boros_pendle_bot` - Pendle Boros bot username
- `DATA_REFRESH_INTERVAL_SECONDS=1800` - Strategy bot refresh interval (30min default)
- `DISCORD_WEBHOOK_URL` - Discord webhook for strategy alerts

**Strategy Thresholds**:
- **SimpleDirectional**: Entry ≥0.5% spread, Exit ≤0.2% spread
- **ImpliedAPRBands**: Long ≤6% APR, Short ≥8% APR, target bands 6.8-7%
- **Alert Cooldowns**: 30-minute default to prevent spam

### Position State Logic

**SimpleDirectionalStrategy State Machine**:
```
NONE → (spread ≥0.5%) → LONG/SHORT → (spread ≤0.2%) → NONE
```
- **Entry**: Underlying > Implied by ≥0.5% → LONG position
- **Entry**: Implied > Underlying by ≥0.5% → SHORT position  
- **Exit**: Spread narrows to ≤0.2% → Close position, return to NONE
- **State Tracking**: Prevents double entries and ensures exit alerts

### Data Structures

**MarketCondition** (strats.py):
- Standardized market data structure for strategy evaluation
- Maps Telegram data to strategy-consumable format
- Includes spread calculation and mock CEX funding rates

**Opportunity Return Format**:
```python
{
    "strategy_type": str,
    "action": str,  # ENTER_LONG, ENTER_SHORT, EXIT_LONG, EXIT_SHORT
    "position_type": str,
    "current_spread": float,
    "expected_apy": float,
    "risk_score": float,
    "max_position_size": int
}
```

### Error Handling & Resilience

- Unicode encoding fallbacks for Windows console compatibility
- FloodWaitError handling with automatic retry delays  
- Graceful degradation when bot interactions fail
- Session file management with automatic re-authentication
- Strategy evaluation continues even if individual strategies fail

### Testing & Validation

- `strategy_bot.py test` - Single analysis run with current data
- `strats.py` - Standalone strategy testing with mock data
- Position state simulation for exit criteria validation
- Discord webhook testing capability