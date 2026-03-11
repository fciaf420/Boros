<p align="center">
  <h1 align="center">Boros</h1>
  <p align="center">
    Automated yield trading on <a href="https://boros.finance">Pendle Boros</a>
    <br />
    <strong>Relative-value strategy + Copy trading</strong>
  </p>
</p>

---

An autonomous TypeScript trading system for Pendle Boros implied APR markets. Run your own strategy or mirror a profitable wallet — all through a unified execution engine with paper and live modes, risk management, and Discord alerts.

Built on the official `@pendle/sdk-boros` and Boros REST API.

## Features

- **Two trading modes** — autonomous relative-value strategy or copy-trade mirroring
- **Paper & live execution** — test strategies risk-free, then go live with the same config
- **Copy trading** — poll any wallet, detect position changes, mirror with proportional sizing
- **Risk management** — kill switch, daily drawdown limits, liquidation buffer checks
- **Smart sizing** — signal-weighted margin allocation across multiple markets
- **Position lifecycle** — TP/SL, trailing stops, partial exits, cross & isolated margin
- **Live order management** — on-chain reconciliation, stale order cancellation, manual close detection
- **SQLite persistence** — snapshots, signals, orders, positions, copy-trade records
- **Discord webhooks** — real-time alerts for entries, exits, failures, and copy actions

---

## Quick Start

```bash
npm install
cp .env.example .env    # configure your credentials
```

```bash
npm run start            # continuous polling
npm run start:once       # single cycle, then exit
npm run typecheck        # type check
npm test                 # run test suite
```

---

## How It Works

### Mode 1: Relative Value Trader (default)

The bot scans all Boros markets and estimates a **fair implied APR** for each one, then trades when the market price diverges far enough to cover costs.

```
                    Boros API
                       |
            +----------+----------+
            |                     |
       Market Data           Order Book
            |                     |
            v                     v
    +----------------+    +---------------+
    | Fair Value Est.|    | Liquidity     |
    | - underlying   |    | - depth check |
    | - 7d average   |    | - slippage    |
    | - 30d average  |    | - fee calc    |
    | - futures prem |    +-------+-------+
    +-------+--------+            |
            |                     |
            v                     v
    +----------------------------------------+
    |          Edge Calculation               |
    |  edge = fair APR - market mid APR       |
    |  net edge = edge - fees - slippage      |
    +-------------------+--------------------+
                        |
                  edge > threshold?
                   /           \
                 YES            NO
                  |              |
                  v              v
          +---------------+   (skip)
          | Size & Risk   |
          | - margin cap  |
          | - leverage    |
          | - kill switch |
          +-------+-------+
                  |
                  v
          +---------------+
          |    Execute    |
          | LiveBroker or |
          | PaperBroker   |
          +---------------+
```

**Fair value estimation** uses the median of clipped APR sources:
- Current underlying APR
- 7-day underlying APR moving average
- 30-day underlying APR moving average
- Futures premium (when available)

**Entry sizing** works in three layers:
1. Total margin budget (respects `MAX_TOTAL_INITIAL_MARGIN_PCT`)
2. Per-slot allocation across remaining market slots
3. Signal-weighted distribution — stronger edges get a bigger share

**Exit conditions**:
- Edge reversal below exit threshold
- Take-profit (default 25% of margin)
- Stop-loss (default 15% of margin)
- Trailing stop (arms at 15%, gives back 10%)
- Position maturity approaching

### Mode 2: Copy Trader

Mirror another wallet's Boros positions in real time. The system polls the target's on-chain positions, detects any changes, and replicates them at your configured size ratio.

```
  Target Wallet (any address)
            |
            v
  Boros REST API (/v1/collaterals/summary)
            |
            v
  +-------------------+
  |  TargetWatcher     |
  |  - fetch positions |
  |  - diff snapshots  |
  +--------+----------+
           |
     what changed?
      /    |    \     \
  ENTER  EXIT  INCREASE  DECREASE
      \    |    /     /
           |
           v
  +-------------------+
  |  CopyExecutor     |
  |  - scale by ratio |
  |  - cap notional   |
  |  - check slippage |
  |  - simulate order |
  +--------+----------+
           |
           v
  +-------------------+
  |  Broker.execute() |
  |  (same as RV mode)|
  +--------+----------+
           |
     +-----+------+
     |            |
  SQLite      Discord
  (record)    (alert)
```

**How position diffing works:**

| Previous Snapshot | Current Snapshot | Delta |
|---|---|---|
| (none) | LONG 1.5 BTC | ENTER LONG |
| LONG 1.5 BTC | (none) | EXIT LONG |
| LONG 1.5 BTC | LONG 2.0 BTC | INCREASE (+0.5) |
| LONG 2.0 BTC | LONG 1.0 BTC | DECREASE (-1.0) |
| LONG 1.5 BTC | SHORT 1.0 BTC | EXIT LONG + ENTER SHORT |

Size changes under 0.1% are ignored to avoid noise from settlement rounding.

---

## Walkthrough: Copy Trading Setup

**1. Find a wallet to copy**

Browse Boros leaderboards or find a profitable trader's address.

**2. Configure your `.env`**

```bash
# Your credentials
BOROS_MODE=live
BOROS_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
BOROS_ACCOUNT_ID=0
BOROS_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
BOROS_ROOT_ADDRESS=0xYOUR_ADDRESS

# Copy trade settings
BOROS_COPY_TRADE_ENABLED=true
BOROS_COPY_TRADE_TARGET_ADDRESS=0xTARGET_WALLET
BOROS_COPY_TRADE_SIZE_RATIO=0.30        # copy at 30% of their size
BOROS_COPY_TRADE_MAX_NOTIONAL_USD=20    # cap per position
BOROS_COPY_TRADE_POLLING_MS=10000       # check every 10s
```

**3. Test with dry run first**

```bash
BOROS_DRY_RUN=true npm run start
```

You'll see position detection without real orders:
```
[copy-trade] starting | mode=live target=0xabc... polling=10000ms
[copy-trade] discovered active account IDs: 0 (using first: 0)
[copy-trade] initial snapshot: 16 active position(s)
  - market=62 side=SHORT size=0.9950 apr=1.66%
  - market=23 side=SHORT size=0.7272 apr=3.17%
  ...
[copy-trade] heartbeat | uptime=1m0s polls=6 positions=16 deltas=0
[copy-trade] heartbeat | uptime=2m0s polls=12 positions=16 deltas=0
[copy-trade] detected 1 position change(s)
[copy-trade] EXECUTE ENTER SHORT market=74 size=0.1500 apr=5.20%
```

**4. Go live**

Remove `BOROS_DRY_RUN` and restart. The bot will execute real orders for any new position changes it detects.

**5. Choosing your size ratio**

| Your Account | Target Total Notional | Recommended Ratio | Max Notional |
|---|---|---|---|
| $75 | $475 | 0.15 | $15 |
| $500 | $475 | 0.50 | $100 |
| $5,000 | $475 | 1.0 | $500 |

Keep in mind Boros has a ~$10 minimum order size. Positions that scale below this will be skipped.

---

## Configuration Reference

### Core Settings

| Variable | Default | Description |
|---|---|---|
| `BOROS_MODE` | `paper` | `paper` (simulated) or `live` (real orders) |
| `BOROS_RPC_URL` | — | Arbitrum RPC endpoint (required for live) |
| `BOROS_ACCOUNT_ID` | — | Your Boros account ID (required for live) |
| `BOROS_PRIVATE_KEY` | — | Wallet private key (required for live) |
| `BOROS_ROOT_ADDRESS` | — | Wallet address (required for live) |
| `BOROS_POLLING_INTERVAL_MS` | `60000` | How often to run the RV strategy cycle |
| `BOROS_DRY_RUN` | `false` | Build orders but don't submit them |

### Risk Management

| Variable | Default | Description |
|---|---|---|
| `BOROS_MIN_EDGE_BPS` | `150` | Minimum edge to enter (basis points) |
| `BOROS_EXIT_EDGE_BPS` | `50` | Edge threshold to exit |
| `BOROS_MAX_CONCURRENT_MARKETS` | `3` | Max simultaneous positions |
| `BOROS_MAX_EFFECTIVE_LEVERAGE` | `1.5` | Leverage cap |
| `BOROS_MAX_DAILY_DRAWDOWN_PCT` | `0.03` | Kill switch at 3% daily loss |
| `BOROS_MAX_FAILURE_STREAK` | `2` | Kill switch after N consecutive failures |
| `BOROS_TAKE_PROFIT_PCT` | `0.25` | TP at 25% of margin |
| `BOROS_STOP_LOSS_PCT` | `0.15` | SL at 15% of margin |
| `BOROS_TRAILING_STOP_ARM_PCT` | `0.15` | Arm trailing stop at 15% profit |
| `BOROS_TRAILING_STOP_GIVEBACK_PCT` | `0.10` | Trail gives back 10% from peak |

### Margin & Sizing

| Variable | Default | Description |
|---|---|---|
| `BOROS_STARTING_EQUITY_USD` | `100000` | Starting equity for paper mode |
| `BOROS_MAX_INITIAL_MARGIN_PCT_PER_MARKET` | `0.10` | Max 10% of equity per market |
| `BOROS_MAX_TOTAL_INITIAL_MARGIN_PCT` | `0.35` | Max 35% of equity total |
| `BOROS_MIN_ORDER_NOTIONAL_USD` | `10` | Minimum order size |
| `BOROS_MARGIN_UTILIZATION_TARGET_PCT` | `0.85` | Target margin utilization |

### Copy Trade

| Variable | Default | Description |
|---|---|---|
| `BOROS_COPY_TRADE_ENABLED` | `false` | Enable copy-trade mode |
| `BOROS_COPY_TRADE_TARGET_ADDRESS` | — | Wallet to mirror |
| `BOROS_COPY_TRADE_TARGET_ACCOUNT_ID` | auto | Auto-discovered if blank |
| `BOROS_COPY_TRADE_SIZE_RATIO` | `1.0` | Our size = target * ratio |
| `BOROS_COPY_TRADE_MAX_NOTIONAL_USD` | `5000` | Cap per copied position |
| `BOROS_COPY_TRADE_POLLING_MS` | `10000` | Poll interval in ms |
| `BOROS_COPY_TRADE_MAX_SLIPPAGE` | `0.10` | Max APR slippage |
| `BOROS_COPY_TRADE_DISCORD_WEBHOOK_URL` | — | Separate webhook for copy alerts |

See `.env.example` for the complete list.

---

## Architecture

```
src/
  index.ts              entry point — routes to RV trader or copy trader
  engine.ts             RelativeValueTrader — main strategy loop
  strategy.ts           fair value estimation (median of clipped APR sources)
  risk.ts               risk state, kill switch, sizing, PnL tracking
  copyTrade.ts          CopyTrader — copy-trade orchestrator
  targetWatcher.ts      target position polling & snapshot diffing
  copyExecution.ts      delta-to-TradeCandidate mapping & sizing
  execution.ts          Broker interface, LiveBroker, PaperBroker
  borosApi.ts           Boros REST API client (markets, order books, simulation)
  config.ts             environment variable loading & validation
  db.ts                 RuntimeStore — SQLite persistence layer
  types.ts              shared TypeScript type definitions
  utils.ts              math helpers (base18 conversion, PnL, APR)
tests/                  vitest unit tests
docs/                   protocol reference notes
```

### Key Abstractions

**`Broker`** — unified interface for order execution. `LiveBroker` sends real orders via the SDK; `PaperBroker` simulates fills locally. Both modes use the same `TradeCandidate` type, making it easy to test strategies before going live.

**`RuntimeStore`** — SQLite-backed persistence for market snapshots, signals, orders, positions, risk state, and copy-trade records. Uses WAL mode for concurrent reads.

**`TargetWatcher`** — stateful position monitor that maintains a snapshot map keyed by market ID. Each `poll()` call fetches current positions, diffs against the previous snapshot, and emits typed deltas.

---

## Runtime Notes

- **Paper mode** writes to SQLite only — never sends transactions or signs anything
- **Live mode** creates an SDK agent, approves it on first run, and places real on-chain orders
- **Heartbeat** logs every 60s in copy-trade mode: uptime, poll count, position count
- **Kill switch** activates on daily drawdown exceeding the cap or consecutive execution failures
- **Isolated markets** are auto-prefunded from cross-margin when entering
- **Manual closes** (via Boros UI) are detected and reconciled on the next cycle
- **New markets** (e.g., Brent Oil) are automatically picked up — no restart needed
- `.env` and `data/` are gitignored — credentials and SQLite files never get committed
