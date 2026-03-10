# Pendle Boros Protocol: Complete Documentation Guide

## Table of Contents
1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [The Basics](#the-basics)
4. [Trading Mechanics](#trading-mechanics)
5. [Settlement System](#settlement-system)
6. [Risk Management](#risk-management)
7. [Advanced Strategies](#advanced-strategies)
8. [Technical Details](#technical-details)
9. [Fees](#fees)
10. [Glossary](#glossary)

---

## Overview

**Boros** is a yield-trading platform on margin by Pendle. It enables traders to:
- Express bullish or bearish views on funding rates
- Hedge floating funding rate exposure (payments or receivables)
- Trade yield units (YU) with leverage

Currently, Boros focuses on trading funding rates from centralized exchanges (Binance, Hyperliquid, etc.), with plans to expand to other yield categories in the future.

### Three Main Components

1. **Interest Rate Accounting** - Obtains yield rates via oracles
2. **Interest Rate Trading (YU Trading)** - Converts floating-yield streams into tradeable units
3. **Margin, Liquidations & Risk** - Manages collateral and position health

---

## Core Concepts

### What are Funding Rates?

Funding rates are periodic payments between long and short position holders on perpetual exchanges that keep contract prices anchored to spot prices:

- **Positive funding rate**: Longs pay shorts (market is bullish, perp price > spot)
- **Negative funding rate**: Shorts pay longs (market is bearish, perp price < spot)

Settlement intervals vary by exchange:
- **Binance**: Every 8 hours
- **Hyperliquid**: Every 1 hour

### Yield Units (YU)

**YU (Yield Units)** represent the future yield of an underlying asset until maturity.

- Each YU equals yield from 1 unit of collateral in the underlying asset
- Example: 5 YU-ETHUSDT-Binance = yield from funding rates on a 5 ETH position on Binance ETHUSDT
- YU has a maturity date - at maturity, YU no longer receives yield and all obligations settle
- YU value decreases over time as yields settle (assuming constant implied APR)
- At maturity, YU value = 0

**For Pendle V2 users**: YU on Boros is analogous to YT (Yield Tokens) on Pendle V2.

---

## The Basics

### Implied APR vs Underlying APR

| Term | Definition |
|------|------------|
| **Implied APR** | The "price" of YU in yield percentage terms. Market consensus on expected average future yield. Becomes your fixed rate upon entry. |
| **Underlying APR** | The actual current yield/funding rate from the underlying exchange |
| **Fixed APR** | Your locked-in rate established at position entry (equals implied APR at entry time) |
| **Mark APR** | Implied APR used for unrealized PnL and liquidation calculations (prevents manipulation) |

### Position Types

#### Long YU
- **Pay**: Fixed APR (implied APR at entry)
- **Receive**: Underlying APR (actual funding rate)
- **Profit when**: Underlying APR > Fixed APR, OR Implied APR increases
- **Use case**: Bullish on funding rates

#### Short YU
- **Pay**: Underlying APR (actual funding rate)
- **Receive**: Fixed APR (implied APR at entry)
- **Profit when**: Fixed APR > Underlying APR, OR Implied APR decreases
- **Use case**: Bearish on funding rates

### Opening and Closing Positions

**Opening**:
1. Deposit collateral
2. Select market
3. Enter desired position size (long or short)
4. Execute market order or place limit order
5. Position opens when order fills

**Closing**:
- Boros automatically opens an opposite position of the same size
- Underlying APR payments cancel out, leaving aggregate fixed APR
- Position is immediately settled into collateral

---

## Trading Mechanics

### Profit Mechanisms

#### Long YU Profits From:
1. **Increase in Underlying APR**
   - Total Profit = (Underlying Yield Collected - Fixed Yield Paid)

2. **Increase in Implied APR** (capital appreciation)
   - "Buy low, sell high" on YU price
   - Close position before maturity at higher implied APR

#### Short YU Profits From:
1. **Decline in Underlying APR**
   - Total Profit = (Fixed Yield Collected - Underlying Yield Paid)

2. **Decline in Implied APR** (capital gain)
   - Close position at lower implied APR than entry

### Order Book

- Orders placed on **Implied APR** (the yield-denominated price)
- **Market orders**: Execute immediately at best available prices
- **Limit orders**: Execute at selected price or better (Good Til Cancel)
- Order book closes at maturity - all orders auto-cancelled

### Vaults

Vaults provide additional liquidity alongside the order book:
- Act as counterparty to open positions
- Earn fees and PENDLE incentives
- Behave similarly to Uniswap V2 LP positions
- **Risk**: Long-biased on YU, vulnerable to impermanent loss if implied APR declines

---

## Settlement System

### Yield Settlement

Settlements occur at the same interval as the underlying exchange:
- Binance pools: Every 8 hours
- Hyperliquid pools: Every 1 hour

### At Each Settlement

| Position | Pay | Receive |
|----------|-----|---------|
| Long YU | Implied APR (fixed) | Underlying APR |
| Short YU | Underlying APR | Implied APR (fixed) |

The difference between rates is:
- **Positive difference**: Collateral increases
- **Negative difference**: Collateral decreases

### At Maturity
- Total position value = 0 (fully realized)
- Collateral is fully freed
- No more yield obligations

---

## Risk Management

### Margin System

#### Cross Margin
- Same collateral can be leveraged across multiple positions within a collateral zone
- Example: BTC collateral for all markets in BTC zone
- Liquidations in one zone don't affect other zones

#### Isolated Pools
- Collateral confined to specific markets only

### Key Margin Terms

| Term | Definition |
|------|------------|
| **Collateral** | Capital backing your position |
| **Initial Margin** | Required margin to open position: `(NotionalSize × YearsToMaturity × ImpliedAPR) / Leverage` |
| **Maintenance Margin** | Minimum capital to keep position open (50% of Initial Margin) |
| **Available Margin** | Collateral not consumed by positions |
| **Margin Floor** | Minimum margin near maturity or low APR to prevent bad debt |
| **Net Balance** | Collateral + Unrealized PnL |

### Leverage
- Ratio of position value to required collateral
- Example: 2x leverage = $10 collateral backs $20 position
- Higher leverage = higher liquidation risk

### Liquidation

**Triggers**: Net Balance falls below Maintenance Margin

**Monitoring Tools**:
1. **Liquidation Implied APR**: Rate at which position becomes liquidatable
2. **Health Factor**: Position health metric (0 = liquidation)

**What Affects Position Health**:
- Changes in Implied APR (price of YU)
- Settlement gains/losses affecting collateral

### Protective Mechanisms

1. **OI Cap**: Hard cap on open interest per market
2. **Closing Only Mode**: Auto-triggered during extreme volatility - only closes allowed
3. **Max Rate Deviation**: Prevents trades too far from mark rate

---

## Advanced Strategies

### 1. Hedging Funding Rate Payments

**Scenario**: You have a LONG position on a perp exchange and pay floating funding rates

**Solution**: Open a **Long YU** position on Boros of the same notional size

**Result**:
- Perp: Pay floating funding rate
- Boros Long YU: Pay fixed APR, receive floating funding rate
- **Net effect**: Pay fixed APR only (floating exposure eliminated)

**Example**:
- 100 BTC long on Binance BTCUSDT (paying ~7.55% APR floating)
- Open 100 YU-BTCUSDT-Binance long at 6% implied APR
- Result: Locked in 6% fixed payment instead of volatile floating rate

### 2. Fixed Funding Rate Receivables

**Scenario**: You have a SHORT position (basis trade) receiving floating funding rates

**Solution**: Open a **Short YU** position on Boros of the same notional size

**Result**:
- Perp: Receive floating funding rate
- Boros Short YU: Pay floating, receive fixed APR
- **Net effect**: Receive fixed APR (floating exposure eliminated)

**Use Case**: Basis traders (like Ethena) who want predictable income

### 3. Implied APR vs Futures Premium Arbitrage

**Key Insight**: Futures premium and funding rates are historically correlated

**Cash-and-Carry via Futures**:
- Hold spot + short futures
- Earn fixed yield from futures premium

**Cash-and-Carry via Perps + Boros**:
- Hold spot + short perp + short YU
- Earn fixed yield at implied APR

**Opportunity**: If implied APR differs significantly from futures premium, arbitrageurs will trade the spread

---

## Technical Details

### Interest Rate Accounting

- Boros obtains yield rates via oracles (e.g., Binance BTCUSDT funding rate)
- Any asset with an oracle feed can be supported
- Underlying APR is settled against each user's fixed APR at every interval

### Position Value Calculation

- Position value decays linearly over time (assuming constant implied APR)
- As yields settle, portion of position realizes into collateral
- Maintenance margin also declines proportionally

### Unrealized PnL

Affected by:
- Current implied APR vs entry implied APR
- Collateral changes from settlements

---

## Fees

### 1. Swap Fees
- Flat fee on implied APR for every swap
- Deducted from position collateral
- Example: 0.05% fee tier = 0.05% × YU amount × Years to Maturity

### 2. Open Interest Fees
- 0.1% flat fee on fixed APR side during settlement
- Long YU: Effectively pays fixed + 0.1%
- Short YU: Effectively receives fixed - 0.1%

### 3. Operation Fees
- ~$1 fee on first transaction and every ~50 transactions
- Covers gas costs for trade execution

### Referral Program
- Using referral code: 10% discount on swap fees
- Referrers receive: 20% of fees generated
- Code generation requires: $1,000,000 notional trading volume
- Code usage eligibility: Under $100,000 trading volume

---

## Glossary

| Term | Definition |
|------|------------|
| **YU (Yield Units)** | Represents yield from 1 unit of collateral in underlying asset |
| **Collateral** | Capital backing your position |
| **Implied APR** | "Price" of YU; market consensus on future yield |
| **Mark APR** | Implied APR for unrealized PnL/liquidation calculations |
| **Underlying APR** | Current APR from underlying exchange (funding rate) |
| **My Fixed APR** | Weighted average implied APR at entry |
| **Long YU** | Pay fixed, receive underlying (bullish on rates) |
| **Short YU** | Pay underlying, receive fixed (bearish on rates) |
| **Maturity** | End of pool; position value becomes zero |
| **Liquidation Implied APR** | Rate at which position becomes liquidatable |
| **Total Position Value** | Current value of open position |
| **Notional Size** | Equivalent underlying asset size for yield |
| **Net Balance** | Collateral + Unrealized PnL |
| **Maintenance Margin** | 50% of Initial Margin; liquidation threshold |
| **Initial Margin** | Required margin for set leverage |
| **Margin Floor** | Minimum margin near maturity/low APR |
| **Health Factor** | Position safety metric (0 = liquidation) |

---

## Quick Reference: How to Win

### For Funding Rate Speculators
1. Deposit collateral
2. Open position:
   - **Long YU** if you expect: average funding rate > current implied APR
   - **Short YU** if you expect: average funding rate < current implied APR
3. Monitor health factor to avoid liquidation

### For YU Traders
1. Deposit collateral
2. Open position:
   - **Long YU** if you expect implied APR to rise (buy low, sell high)
   - **Short YU** if you expect implied APR to fall (short a falling price)
3. Monitor health factor to avoid liquidation

---

## Links

- **Boros App**: https://boros.pendle.finance
- **Account/Referral**: https://boros.pendle.finance/account
- **Documentation**: https://pendle.gitbook.io/boros

---

*Document compiled from official Pendle Boros documentation - February 2026*
