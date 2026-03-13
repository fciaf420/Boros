# Boros API Reference

## Table of Contents
- [Base URL and Auth](#base-url)
- [Markets and Data](#markets-and-data)
- [Indicators](#indicators)
- [Order Book](#order-book)
- [Positions and Collateral](#positions-and-collateral)
- [Simulation](#simulation)
- [Equity and PnL](#equity-and-pnl)
- [Orders](#orders)
- [Settlements](#settlements)
- [Referrals and Volume](#referrals-and-volume)
- [Assets](#assets)
- [Error Handling](#error-handling)
- [Data Encoding](#data-encoding)

## Base URL

```
https://api.boros.finance/core
```

All endpoints are read-only GETs returning JSON. No authentication required for market data. Trade execution uses on-chain signing (separate from API).

## Markets and Data

### List Markets
```
GET /v1/markets?limit=100&isWhitelisted=true
```
Returns `{ results: MarketSummary[] }`. Each market has:
- `marketId`, `tokenId`, `address`, `state` ("Normal", etc.)
- `imData`: name, symbol, tickStep, isIsolatedOnly, maturity, marginFloor
- `metadata`: platformName, assetSymbol, maxLeverage, defaultLeverage
- `extConfig`: paymentPeriod (settlement frequency in seconds)
- `data`: nextSettlementTime, timeToMaturity, assetMarkPrice, midApr, markApr, bestBid, bestAsk, floatingApr, longYieldApr, volume24h, notionalOI

### Market Filtering
Eligible markets must satisfy:
- `isWhitelisted = true`
- `state = "Normal"`
- `timeToMaturity >= minDaysToMaturity * 86400`
- Not isolated-only (unless config allows)
- In `allowedMarketIds` (if set)

## Indicators

### Fetch APR Indicators
```
GET /v2/markets/indicators?marketId={id}&timeFrame=1h&select=u,fp,udma:7;30
```
Returns indicator time series:
- `u`: Underlying APR (current funding rate)
- `fp`: Futures premium
- `udma:7`: 7-day underlying APR moving average
- `udma:30`: 30-day underlying APR moving average

These four sources are the inputs to the fair value estimation model.

## Order Book

### Fetch Order Book
```
GET /v1/order-books/{marketId}?tickSize=0.001
```
Returns:
```json
{
  "long": { "ia": [tick1, tick2, ...], "sz": ["size1_base18", ...] },
  "short": { "ia": [tick1, tick2, ...], "sz": ["size1_base18", ...] }
}
```
- `long.ia`/`short.ia`: Arrays of tick indices (APR levels)
- `long.sz`/`short.sz`: Arrays of sizes at each tick in base18 encoding
- Best bid = first long tick, best ask = first short tick
- Use for liquidity checks and order placement

### Tick Normalization
Boros uses discrete ticks with a `tickStep`. Normalize:
- Maker: Round DOWN for long (better price), UP for short
- Taker: Round UP for long (cross to ask), DOWN for short (cross to bid)

## Positions and Collateral

### Collateral Summary (positions + margin)
```
GET /v1/collaterals/summary?userAddress={addr}&accountId={id}
```
Returns `{ collaterals: [...] }`. Each collateral entry has:
- `tokenId`, `totalNetBalance` (base18), `startDayNetBalance` (base18)
- `availableBalance` (base18)
- `crossPosition`: `{ availableBalance, initialMargin, marketPositions: [...] }`
- `isolatedPositions`: `[{ tokenId, marketPositions: [...] }]`

Each `marketPosition` has:
- `marketId`, `side` (0=LONG, 1=SHORT), `notionalSize` (base18)
- `fixedApr`, `markApr`, `liquidationApr`
- `positionValue`: `{ settledPosition, remainingPosition, totalValue }`
- `pnl`: `{ unrealisedPnl }` (note: British spelling)
- `initialMarginRequired` (base18)

**Important**: Collateral values are in token units (base18), not USD. Multiply by token price from `/v2/assets/all`.

### Active Positions (simpler view)
```
GET /v1/collaterals/summary?userAddress={addr}&accountId={id}
```
Same endpoint, extract `marketPositions` from cross and isolated sections.

## Simulation

### Simulate Order
```
GET /v2/simulations/place-order?marketId={id}&side={0|1}&size={base18}&tif={2|3}&limitTick={tick}&slippage={pct}
```
Parameters:
- `side`: 0 = LONG, 1 = SHORT
- `size`: Position size in base18
- `tif`: 2 = FILL_OR_KILL (taker), 3 = maker
- `limitTick`: Tick index for limit price
- `slippage`: Max slippage percentage (e.g., 0.05 = 5%)

Returns:
- `marginRequired` (base18)
- `actualLeverage`
- `liquidationApr`
- `liquidationBufferBps`
- `priceImpact` (bps)
- `feeBreakdown.totalFee` (base18)
- `status`: "success", "walletnotconnected" (still usable for simulation), or error codes

### Simulation Error Codes
- `TRADE_ALOAMM_NOT_ALLOWED`: Maker order rejected, fallback to taker
- `ORDER_VALUE_TOO_LOW`: Size below minimum ($10), retry with larger size
- `WalletNotConnected`: Non-fatal in paper/simulation mode

## Equity and PnL

### Equity Curve
```
GET /v1/portfolios/balance-chart/all?userAddress={addr}&accountId=0&time=all
```
Returns `{ balanceCharts: [{ historicalBalances: [{ t: timestamp, u: usdValue }] }] }`.

**Warning**: Includes deposits/withdrawals as equity changes. Use jump detection (>20% single-step change) to filter deposits when computing trading returns.

### PnL Transactions
```
GET /v1/pnl/transactions?skip=0&limit=200&userAddress={addr}&accountId=0
```
Returns per-trade PnL records with `pnl` (base18), `fee` (base18), `fixedApr`, `entryApr`, `pnlPercentage`.

## Orders

### Order History
```
GET /v2/pnl/limit-orders?skip=0&limit=200&userAddress={addr}&accountId=0&isActive=false
```
Returns filled orders with `status` (2 = filled), `marketId`, `placedTimestamp`.

**Note**: Some orders have null/undefined `placedTimestamp`. Guard against this.

## Settlements

### Settlement History
```
GET /v1/settlement/settlements?skip=0&limit=200&userAddress={addr}&accountId=0
```
Returns per-settlement records: `yieldPaid`, `yieldReceived`, `settlement` (net), `settlementRate`, `paidApr`, `receivedApr`.

## Referrals and Volume

### Referral Info
```
GET /v1/referrals/{address}
```
Returns `referralCode`, `totalTradeVolume`, `feeSharePercentage`.

### User Volume
```
GET /v1/volume?user={address}
```

## Assets

### All Token Metadata
```
GET /v2/assets/all
```
Returns all collateral tokens with `tokenId`, `symbol`, `decimals`, `usdPrice`.

Known tokens:
- tokenId 1: WBTC (~$70K)
- tokenId 2: WETH (~$2070)
- tokenId 3: USDC ($1)
- tokenId 4: BNB (~$651)
- tokenId 5: HYPE (~$37)

## Error Handling

All API errors return JSON with `errorCode` and optional `contractCode`. Standard HTTP status codes:
- 400: Bad request (invalid parameters)
- 404: Not found
- 429: Rate limited
- 500/502: Server error

Implement retry with backoff for 429/5xx. Treat 4xx as permanent failures.

## Data Encoding

- **Base18**: Large numbers encoded as strings. `1e18 = 1 unit`. Convert: `Number(BigInt(value)) / 1e18`
- **APR**: Decimal format. `0.07 = 7%`
- **Side**: `0 = LONG`, `1 = SHORT`
- **TIF**: `2 = FILL_OR_KILL` (taker), `3 = maker`
- **Tick indices**: Discrete price levels. Must be normalized to `tickStep`
- **Timestamps**: Unix seconds (not milliseconds)
- **PnL spelling**: British `unrealisedPnl` (not `unrealizedPnl`)
