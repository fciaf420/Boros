# Boros Protocol Reference

## Table of Contents
- [What is Boros](#what-is-boros)
- [Funding Rates](#funding-rates)
- [Yield Units (YU)](#yield-units)
- [Implied vs Underlying APR](#implied-vs-underlying-apr)
- [Opening and Closing Positions](#positions)
- [Settlement](#settlement)
- [Long Rates](#long-rates)
- [Short Rates](#short-rates)
- [Margin and Liquidation](#margin-and-liquidation)
- [Advanced Strategies](#advanced-strategies)
- [Execution Environment](#execution-environment)

## What is Boros

Boros is Pendle's yield-trading platform on margin. It supports margin trading on variable interest rates, starting with funding-rate markets from perpetual exchanges (Binance, Hyperliquid, etc.).

Users trade Yield Units (YU) to speculate on or hedge funding rate exposure. The platform combines a central limit order book with AMM liquidity in a hybrid execution model.

## Funding Rates

Funding rates are periodic payments between traders in perpetual futures markets that keep perp prices aligned with spot.

- **Positive funding rate**: Longs pay shorts
- **Negative funding rate**: Shorts pay longs
- **Settlement intervals**: Binance = 8h, Hyperliquid = 1h
- **Volatility**: Can swing dramatically (e.g., 228% annualized change in 48h on BTC)
- **Annualization**: Rates are presented per-interval, multiply by intervals/year for APR

Example: 0.0013% hourly rate on $100K = $1.30/hour = ~$11,388/year = ~11.4% APR.

## Yield Units

YU represents future yield of an underlying asset until maturity.

- `5 YU-ETHUSDT-Binance` = yield from funding rates on a 5 ETH position on Binance
- Priced in Implied APR (the cost to buy/sell YU)
- Every YU has a maturity date
- Value decays toward zero as settlements occur
- Similar to Pendle V2 Yield Tokens (YT) but with leverage

## Implied vs Underlying APR

**Implied APR**: Market-determined price of YU. Locks in as fixed rate at entry. Reflects market expectation of average funding until maturity.

**Underlying APR**: Actual realized funding rate from the perp exchange. Changes every settlement period.

**Relationship**:
- Long: Pay implied (fixed), receive underlying (floating)
- Short: Pay underlying (floating), receive implied (fixed)
- Profit when your side exceeds the other

**Trading signal**: If you forecast underlying > implied, go long. If implied > expected underlying, go short.

## Positions

**Long YU**: Pay current implied APR (fixed), receive underlying APR (floating). Bullish on rates.

**Short YU**: Pay underlying APR (floating), receive implied APR (fixed). Bearish on rates.

**Closing**: Boros automatically opens an opposite position of same size to close.

**Collateral**: Must have sufficient balance before opening. Position size backed by available collateral.

## Settlement

Yields settle periodically, synchronized with the underlying venue's funding schedule.

- **Binance pools**: Every 8 hours
- **Hyperliquid pools**: Every 1 hour
- At each interval, difference between fixed and underlying rates is settled to collateral
- **Long profit**: When underlying > fixed at settlement snapshot
- **Short profit**: When fixed > underlying at settlement snapshot
- Collateral increases when received > paid, decreases when received < paid
- Repeats every settlement until maturity

## Long Rates

Enter long when expecting funding rates to increase. Two profit drivers:

1. **Carry**: Underlying APR exceeds fixed APR across settlements
2. **Capital gains**: Implied APR rises (YU price increases), exit early at profit

Risk: Underlying APR falls below fixed rate, creating negative carry each settlement.

## Short Rates

Enter short when expecting funding rates to decrease. Two profit drivers:

1. **Carry**: Fixed APR exceeds underlying APR across settlements
2. **Capital gains**: Implied APR drops (YU price decreases), close position cheaper

Risk: Underlying APR rises above fixed rate, creating negative carry.

## Margin and Liquidation

**Available Margin**: Total collateral available for new positions.

**Margin Required**: Collateral reserved for a position. Unavailable for other trades.

**Notional Size**: Underlying asset exposure (e.g., 20 ETH at 2x leverage on 10 ETH collateral).

**Leverage**: Supported similar to perps. Higher leverage = higher liquidation risk.

**Liquidation monitoring**:
- **Liquidation Implied APR**: APR threshold where position liquidates (like liquidation price on perps)
- **Health Factor**: Safety metric. Position liquidated when health factor reaches 0.
- **Liquidation Buffer (bps)**: Distance to liquidation in basis points. Track this closely.

**Cross vs Isolated margin**: Some markets are isolated-only (separate collateral pools). Cross margin shares collateral across positions.

## Advanced Strategies

### Hedging Funding Rate Payments
Long perp position + Long YU on Boros (same notional) = Convert floating funding cost to fixed. Profitable when implied APR < expected floating rate.

### Fixed Funding Rate Receivables
Short perp position + Short YU on Boros (same notional) = Lock in fixed income from funding. For basis traders wanting predictable yield.

### Implied APR vs Futures Premium Arbitrage
Futures premium and Boros implied APR track similar risk profiles. Disparities create arbitrage: take the higher-yield strategy, unwind the other. Futures premium can be a leading indicator for implied APR.

## Execution Environment

- Hybrid CLOB + AMM liquidity
- Must reason about both quoted price and fill quality
- Relies on yield-rate oracles for underlying rate series
- Treat oracle/funding data integrity as first-class dependency
- Multiple fee layers: swap fees, OI fees, intermittent operation fees, slippage
- All fees must be subtracted before labeling a trade as valid
