# Trading Strategy Reference

## Table of Contents
- [Fair Value Estimation](#fair-value-estimation)
- [Edge Calculation](#edge-calculation)
- [Settlement-Adjusted Scoring](#settlement-adjusted-scoring)
- [Position State Machine](#position-state-machine)
- [Exit Conditions](#exit-conditions)
- [Position Sizing](#position-sizing)
- [Budget Allocation](#budget-allocation)
- [Order Management](#order-management)
- [PnL Calculation](#pnl-calculation)
- [Risk Management](#risk-management)
- [Copy Trade System](#copy-trade-system)
- [Configuration Reference](#configuration-reference)

## Fair Value Estimation

Compute median fair APR from 4 sources:
1. `u` - Current underlying APR (live funding rate)
2. `fp` - Futures premium (annualized basis)
3. `udma:7` - 7-day underlying APR moving average
4. `udma:30` - 30-day underlying APR moving average

All sources clipped to `midApr +/- clipAprWindowBps` (default 500bps) before taking median. This prevents outliers from distorting the fair value.

## Edge Calculation

```
edgeBpsLong  = (fairApr - midApr) * 10,000
edgeBpsShort = (midApr - fairApr) * 10,000
netEdgeBps   = edgeBps - priceImpactBps - feeBps - safetyBufferBps
```

A trade is only valid when `netEdgeBps >= minEdgeBps` (default 150bps).

## Settlement-Adjusted Scoring

Markets settle at different frequencies. Faster settlement = faster carry realization.

```
adjustedEdge = edgeBps * (28800 / paymentPeriodSeconds)
```

Where 28800 = 8 hours in seconds (baseline).

| Venue | Period | Multiplier |
|-------|--------|-----------|
| Hyperliquid | 1h (3600s) | 8x |
| Binance | 8h (28800s) | 1x |

A 150bps edge in a 1h market scores as 1200bps adjusted. This affects market ranking and budget allocation.

## Position State Machine

```
No Position --> [ENTER: edge >= minEdgeBps] --> OPEN
OPEN --> [ADD: edge improved 25bps+, PnL >= 0, addCount < 1] --> OPEN (larger)
OPEN --> [EXIT: see exit conditions] --> CLOSED
```

## Exit Conditions

Exit when ANY of these trigger:

| Condition | Threshold | Description |
|-----------|-----------|-------------|
| Edge reversal | exitEdgeBps (50) | Opposite side's edge exceeds threshold |
| Liquidation risk | minMaintainLiqBufferBps (200) | Buffer too thin |
| Take profit | takeProfitPnlPct (0.25) | PnL >= 25% of margin |
| Stop loss | stopLossPnlPct (0.15) | PnL <= -15% of margin |
| Trailing stop | trailingStopGivebackPct (0.10) | Gives back 10% from peak PnL |

Trailing stop arms at `trailingStopArmPct` (15% peak PnL), then triggers if PnL drops 10% from peak.

## Position Sizing

### Entry sizing
```
targetLeverage = min(market.defaultLeverage, market.maxLeverage, config.maxEffectiveLeverage)
initialSizeBase = marginBudgetUsd * targetLeverage / assetMarkPrice
```

### Constraints applied in order
1. Notional cap: `maxInitialMarginPctPerMarket * equity`
2. Leverage cap: `maxEffectiveLeverage` (1.5x default)
3. Liquidity cap: `bestOfBookSize / minLiquidityCoverage` (book/3 default)
4. Minimum: `minOrderNotionalUsd` ($10)
5. Simulation validation: margin, leverage, liquidation buffer all checked

### Add sizing
Weighted average APR computed when adding to existing position:
```
newEntryApr = (existing.notional * existing.entryApr + added.notional * added.fillApr) / totalNotional
```

## Budget Allocation

When multiple ENTER signals exist:

1. Collect all candidates with edge > 0
2. Score each: `adjustedScore = settlementAdjustedEdge(edge, paymentPeriod)`
3. Allocate remaining margin budget proportional to score
4. Each gets `min(rawAllocation, perMarketCapUsd)`
5. `perMarketCapUsd = equity * maxInitialMarginPctPerMarket`

## Order Management

### Intent selection
- **Maker (TIF=3)**: Edge < aggressiveEntryEdgeBps (300bps). Passive, better fill price.
- **Taker (TIF=2, FOK)**: Edge >= aggressiveEntryEdgeBps OR exit orders. Immediate fill.

### Stale order cancellation
- Entry orders: cancel after `liveEntryOrderTtlSeconds` (600s = 10min)
- Exit orders: cancel after `liveExitOrderTtlSeconds` (180s = 3min)

### Retry logic
Up to 6 retries with:
- Intent switching (maker to taker if ALOAMM rejected)
- Size increases (for ORDER_VALUE_TOO_LOW)
- Margin adjustments toward utilization target

## PnL Calculation

Four components tracked per position:

### Realized Carry PnL
Accumulated from settlements: `(floating - fixed) * notional * yearsElapsed` for LONG, inverse for SHORT.

### Realized Trading PnL
From exit fills at different APRs than entry.

### Unrealized PnL
Mark-to-market based on current midApr vs entryApr, scaled by time remaining to maturity.

### Peak PnL
Tracks highest PnL ever reached, used for trailing stop calculation.

## Risk Management

### Portfolio-level controls
| Parameter | Default | Description |
|-----------|---------|-------------|
| maxTotalInitialMarginPct | 0.35 | Max 35% of equity in margin |
| maxInitialMarginPctPerMarket | 0.10 | Max 10% per market |
| maxConcurrentMarkets | 3 | Max simultaneous positions |
| maxEffectiveLeverage | 1.5 | Max leverage per trade |
| maxDailyDrawdownPct | 0.03 | Kill switch at -3% daily |
| maxFailureStreak | 2 | Kill switch after 2 failures |

### Entry gates
| Check | Threshold | Description |
|-------|-----------|-------------|
| Net edge | minEdgeBps (150) | After costs |
| Liquidity | minLiquidityCoverage (3) | Size < book/3 |
| Liq buffer | minEntryLiqBufferBps (400) | Distance to liquidation |
| Maturity | minDaysToMaturity (14) | Days until expiry |
| Margin | marginUtilizationTargetPct (0.85) | Budget available |

### Kill switch
Halts all trading when:
- Daily drawdown > maxDailyDrawdownPct
- Consecutive failures >= maxFailureStreak

Recoverable via: `appendKillSwitchEvent("resolved", { reason: "..." })`

### Isolated markets
- `autoFundIsolatedMarkets`: Move collateral to isolated markets automatically
- `isolatedMarginBufferBps`: Buffer when checking isolated margin (500bps)
- `minIsolatedCashTopupUsd`: Minimum transfer amount ($10)

## Copy Trade System

### Architecture
- **TargetWatcher**: Polls target wallet positions every N ms, diffs against previous snapshot
- **CopyExecutor**: Converts position deltas to orders scaled by sizeRatio
- **CopyTrader**: Orchestrates the loop with kill switch and reconciliation

### Delta types
| Action | Trigger | Behavior |
|--------|---------|----------|
| ENTER | Target opened new position | Copy with scaled size |
| INCREASE | Target grew size > 0.1% | Add to our position |
| DECREASE | Target shrunk size > 0.1% | Reduce our position |
| EXIT | Target closed position | Close our copy position |
| Side flip | LONG to SHORT or vice versa | EXIT + ENTER |

### Copy execution flow
1. Scale target size by `sizeRatio`
2. Cap by `maxNotionalUsd`
3. Cap by available liquidity / `minLiquidityCoverage`
4. Round up to minimum if enabled (with 5% buffer)
5. Simulate order (taker for immediate fill)
6. Check slippage vs target's entry APR
7. Skip EXIT/DECREASE/INCREASE if we have no position in that market

### Copy trade config
| Parameter | Default | Description |
|-----------|---------|-------------|
| pollingMs | 10000 | Check every 10s |
| sizeRatio | 1.0 | 1:1 copy ratio |
| maxNotionalUsd | 5000 | Max per order |
| maxSlippage | 0.10 | 10% max APR slippage |
| maxConcurrentPositions | 10 | Max open positions |
| maxFailureStreak | 5 | Kill switch threshold |
| deltaDeadzone | 0.001 | Ignore < 0.1% size changes |

## Configuration Reference

### Environment variables (all prefixed BOROS_)

#### Core
| Var | Default | Description |
|-----|---------|-------------|
| MODE | paper | "paper" or "live" |
| POLLING_INTERVAL_MS | 60000 | Strategy evaluation interval |
| STARTING_EQUITY_USD | 100000 | Initial paper equity |
| DRY_RUN | false | Plan but don't execute |
| SQLITE_PATH | data/boros_trader.sqlite | Database location |

#### Edge & Signals
| Var | Default | Description |
|-----|---------|-------------|
| MIN_EDGE_BPS | 150 | Minimum entry edge |
| EXIT_EDGE_BPS | 50 | Edge to trigger exit |
| AGGRESSIVE_ENTRY_BPS | 300 | Edge for taker entry |
| CLIP_APR_WINDOW_BPS | 500 | Fair value clip window |

#### Risk
| Var | Default | Description |
|-----|---------|-------------|
| MAX_INITIAL_MARGIN_PCT_PER_MARKET | 0.10 | 10% per market |
| MAX_TOTAL_INITIAL_MARGIN_PCT | 0.35 | 35% total |
| MAX_CONCURRENT_MARKETS | 3 | Position limit |
| MAX_EFFECTIVE_LEVERAGE | 1.5 | Leverage cap |
| MAX_DAILY_DRAWDOWN_PCT | 0.03 | 3% daily stop |
| MAX_FAILURE_STREAK | 2 | Failure kill switch |
| MIN_LIQUIDITY_COVERAGE | 3 | Book depth requirement |
| MIN_ENTRY_LIQ_BUFFER_BPS | 400 | Entry liq buffer |
| MIN_MAINTAIN_LIQ_BUFFER_BPS | 200 | Ongoing liq buffer |

#### Position Management
| Var | Default | Description |
|-----|---------|-------------|
| TAKE_PROFIT_PCT | 0.25 | 25% TP |
| STOP_LOSS_PCT | 0.15 | 15% SL |
| TRAILING_STOP_ARM_PCT | 0.15 | Arm at 15% |
| TRAILING_STOP_GIVEBACK_PCT | 0.10 | Trail 10% |
| MIN_DAYS_TO_MATURITY | 14 | Maturity filter |
| MARKET_ORDER_SLIPPAGE | 0.05 | 5% taker slippage |

#### Order TTL
| Var | Default | Description |
|-----|---------|-------------|
| AUTO_CANCEL_STALE_LIVE_ORDERS | true | Enable TTL |
| LIVE_ENTRY_ORDER_TTL_SECONDS | 600 | 10min entries |
| LIVE_EXIT_ORDER_TTL_SECONDS | 180 | 3min exits |

#### Isolated Markets
| Var | Default | Description |
|-----|---------|-------------|
| ALLOW_ISOLATED_MARKETS | true | Trade isolated |
| AUTO_FUND_ISOLATED_MARKETS | true | Auto-fund |
| ISOLATED_MARGIN_BUFFER_BPS | 500 | Buffer |
| MIN_ISOLATED_CASH_TOPUP_USD | 10 | Min transfer |

#### Live Mode
| Var | Default | Description |
|-----|---------|-------------|
| RPC_URL | - | Arbitrum RPC |
| ACCOUNT_ID | - | Boros account |
| ROOT_ADDRESS | - | Wallet address |
| PRIVATE_KEY | - | Signing key |

#### Copy Trade (prefix BOROS_COPY_TRADE_)
| Var | Default | Description |
|-----|---------|-------------|
| ENABLED | false | Enable copy |
| TARGET_ADDRESS | 0x0... | Target wallet |
| TARGET_ACCOUNT_ID | - | Account ID |
| POLLING_MS | 10000 | Poll interval |
| SIZE_RATIO | 1.0 | Copy ratio |
| MAX_NOTIONAL_USD | 5000 | Max per order |
| MAX_SLIPPAGE | 0.10 | 10% max |
| ROUND_UP_TO_MIN | true | Round up small orders |
