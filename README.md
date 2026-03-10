# Boros

TypeScript trader for [Pendle Boros](https://boros.finance) using the official API and `@pendle/sdk-boros`.

Two modes of operation: **relative-value trading** (autonomous strategy) or **copy trading** (mirror another wallet).

## Quick Start

```bash
npm install
cp .env.example .env   # edit with your credentials
npm run start           # continuous polling
npm run start:once      # single cycle
```

## Modes

### Relative Value Trader (default)

Estimates fair implied APR from underlying rates, 7d/30d averages, and futures premium. Trades when edge exceeds fees + slippage + liquidation buffer.

Sizing: total margin budget > per-slot allocation > signal-weighted distribution.

### Copy Trader

Mirrors another wallet's Boros positions in real time. Polls the target via the Boros API, detects position changes (enter/exit/increase/decrease), and executes through the same broker.

```
BOROS_COPY_TRADE_ENABLED=true
BOROS_COPY_TRADE_TARGET_ADDRESS=0x...
```

| Variable | Default | Description |
|---|---|---|
| `SIZE_RATIO` | `1.0` | Our size = target * ratio |
| `MAX_NOTIONAL_USD` | `5000` | Cap per position |
| `POLLING_MS` | `10000` | Check interval |
| `MAX_SLIPPAGE` | `0.10` | Max APR drift vs target |
| `TARGET_ACCOUNT_ID` | auto | Auto-discovered if blank |
| `DISCORD_WEBHOOK_URL` | — | Optional alerts |

All prefixed with `BOROS_COPY_TRADE_`. Use `BOROS_DRY_RUN=true` to log without executing.

## Configuration

### Required for live mode

| Variable | Description |
|---|---|
| `BOROS_MODE` | `paper` or `live` |
| `BOROS_RPC_URL` | Arbitrum RPC endpoint |
| `BOROS_ACCOUNT_ID` | Your Boros account ID |
| `BOROS_PRIVATE_KEY` | Wallet private key |
| `BOROS_ROOT_ADDRESS` | Wallet address |

### Key trading parameters

`BOROS_MIN_EDGE_BPS`, `BOROS_MAX_CONCURRENT_MARKETS`, `BOROS_MAX_EFFECTIVE_LEVERAGE`, `BOROS_MIN_ORDER_NOTIONAL_USD`, `BOROS_ALLOW_ISOLATED_MARKETS`, `BOROS_AUTO_FUND_ISOLATED_MARKETS`

See `.env.example` for the full list with defaults.

## Project Layout

```
src/
  index.ts              entry point (routes to RV trader or copy trader)
  engine.ts             relative-value trading engine
  copyTrade.ts          copy-trade orchestrator
  targetWatcher.ts      target position monitoring & diffing
  copyExecution.ts      trade mapping & proportional sizing
  execution.ts          LiveBroker / PaperBroker
  borosApi.ts           Boros REST API client
  config.ts             env var loading
  db.ts                 SQLite state store
  types.ts              shared type definitions
  risk.ts               risk state & kill switch
  fairValue.ts          fair APR estimation
  utils.ts              math helpers
tests/                  unit tests
docs/                   protocol notes
```

## Runtime Notes

- `paper` mode writes to SQLite only, never sends transactions
- `live` mode places real orders via the Boros SDK
- Manual UI closes are reconciled on the next cycle
- Isolated markets are prefunded automatically when enabled
- `.env` and `data/` are gitignored
