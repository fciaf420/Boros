# Boros

TypeScript trader for Pendle Boros using the official Boros API and `@pendle/sdk-boros`.

The repo still contains the original Python Telegram tooling for research, but the active trading path is the TypeScript service in `src/`.

## Current Scope

- Boros-only execution
- `paper` and `live` modes
- SQLite state store for snapshots, signals, orders, positions, and runtime state
- relative-value signal engine on implied APR vs fair APR
- isolated and cross-market live trading
- TP, SL, and trailing-stop exits
- live order reconciliation and manual-close position sync

## Strategy Summary

The bot estimates a fair implied APR from:

- current underlying APR
- 7d underlying APR
- 30d underlying APR
- futures premium when available

It trades when the edge is large enough after fees, slippage, liquidity, and liquidation checks.

Entry sizing now works in three layers:

1. total margin budget
2. per-slot allocation across remaining markets
3. signal-weighted allocation so stronger edges can use a bigger share of available capital

## Project Layout

- `src/`: TypeScript trader
- `tests/`: unit/integration tests
- `docs/BOROS_PROTOCOL_GUIDE.md`: protocol notes
- `telethon_rates.py`: legacy Telegram data collection
- `strategy_bot.py`: legacy Python strategy runner
- `strats.py`: legacy Python strategy definitions

## Setup

```bash
npm install
cp .env.example .env
```

Important live vars:

- `BOROS_MODE=paper|live`
- `BOROS_RPC_URL`
- `BOROS_ACCOUNT_ID`
- `BOROS_PRIVATE_KEY`
- `BOROS_ROOT_ADDRESS`

Important trading vars:

- `BOROS_MAX_INITIAL_MARGIN_PCT_PER_MARKET`
- `BOROS_MAX_TOTAL_INITIAL_MARGIN_PCT`
- `BOROS_MAX_CONCURRENT_MARKETS`
- `BOROS_MAX_EFFECTIVE_LEVERAGE`
- `BOROS_MARGIN_UTILIZATION_TARGET_PCT`
- `BOROS_MIN_ORDER_NOTIONAL_USD`
- `BOROS_ALLOW_ISOLATED_MARKETS`
- `BOROS_AUTO_FUND_ISOLATED_MARKETS`

## Commands

```bash
npm run start
npm run start:once
npm run typecheck
npm test
```

## Runtime Notes

- `paper` mode writes to SQLite and never sends transactions.
- `live` mode uses the Boros SDK and will place real orders.
- Maker orders can rest on-chain without creating a filled position immediately.
- Manual UI closes are reconciled on the next bot cycle.
- Isolated markets are prefunded automatically when enabled.

## Git Hygiene

- `.env` is ignored and should never be committed.
- `data/` and `tmp/` are ignored.
- SQLite runtime files are ignored.

## Legacy Python Tooling

The Python Telegram scraper and strategy files remain in the repo for reference and historical comparison, but they are not the production execution path anymore.
