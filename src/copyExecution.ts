import type { BorosApiClient } from "./borosApi.js";
import type { CopyTradeConfig, MarketSummary, TargetPositionDelta, TradeCandidate } from "./types.js";
import { toBase18 } from "./utils.js";

export class CopyExecutor {
  constructor(
    private readonly config: CopyTradeConfig,
    private readonly api: BorosApiClient,
  ) {}

  computeCopySize(targetSizeBase: number): number {
    const scaled = targetSizeBase * this.config.sizeRatio;
    // We can't directly cap by notional here since we don't know the asset price yet,
    // so return the scaled size. Notional cap is applied in buildCopyCandidate.
    return scaled;
  }

  async buildCopyCandidate(
    delta: TargetPositionDelta,
    market: MarketSummary,
  ): Promise<TradeCandidate> {
    // Map DeltaAction to ActionType
    const action = delta.action === "ENTER" ? "ENTER"
      : delta.action === "EXIT" ? "EXIT"
      : delta.action === "INCREASE" ? "ADD"
      : "EXIT"; // DECREASE maps to EXIT (partial)

    // For ENTER/INCREASE we use the delta's sizeChangeBase; for EXIT/DECREASE we also use sizeChangeBase
    let sizeBase = this.computeCopySize(delta.sizeChangeBase);

    // Apply notional cap
    const notionalUsd = sizeBase * market.assetMarkPrice;
    if (notionalUsd > this.config.maxNotionalUsd) {
      sizeBase = this.config.maxNotionalUsd / market.assetMarkPrice;
    }

    // Liquidity check: fetch order book and cap size by available liquidity
    const orderBook = await this.api.fetchOrderBook(market.marketId);
    const availableLiquidity = delta.side === "LONG"
      ? orderBook.bestShortSizeBase
      : orderBook.bestLongSizeBase;

    if (!availableLiquidity) {
      throw new Error(`No order book liquidity for ${delta.side} side`);
    }

    const liquidityCap = availableLiquidity / this.config.minLiquidityCoverage;
    if (sizeBase > liquidityCap) {
      sizeBase = liquidityCap;
    }

    // Round up or skip orders below exchange minimum
    const preNotionalUsd = sizeBase * market.assetMarkPrice;
    if (preNotionalUsd < this.config.minOrderNotionalUsd) {
      if (this.config.roundUpToMinNotional && action !== "EXIT") {
        // Add 5% buffer to avoid rounding/precision rejections from the API
        sizeBase = (this.config.minOrderNotionalUsd * 1.05) / market.assetMarkPrice;
      } else {
        throw new Error(`Order notional $${preNotionalUsd.toFixed(2)} below $${this.config.minOrderNotionalUsd} minimum`);
      }
    }

    const sizeBase18 = toBase18(sizeBase);
    const finalNotionalUsd = sizeBase * market.assetMarkPrice;

    // Use taker for copy trades (we want immediate fills)
    const orderIntent = "taker" as const;

    // Determine order APR and tick from order book (already fetched above for liquidity check)
    // orderApr = real APR from market (for slippage checks)
    // orderTick = raw tick index from order book (for limitTick on the order)
    let orderApr: number;
    let orderTick: number | undefined;
    if (delta.side === "LONG") {
      // Buying long means taking the ask (short side of book)
      orderApr = market.bestAsk;
      orderTick = orderBook.bestShortTick;
    } else {
      // Buying short means taking the bid (long side of book)
      orderApr = market.bestBid;
      orderTick = orderBook.bestLongTick;
    }

    // Check slippage vs target's entry APR
    const slippage = Math.abs(orderApr - delta.targetEntryApr);
    if (slippage > this.config.maxSlippage) {
      // Still build the candidate but note it in rationale - caller decides to skip
    }

    // Simulate the order for margin/fee data
    // tif=2 is FILL_OR_KILL
    const simulation = await this.api.simulateOrder({
      marketId: market.marketId,
      side: delta.side,
      sizeBase18,
      tif: 2,
      slippage: this.config.maxSlippage,
    });

    const rationale = `Copy trade: ${delta.action} ${delta.side} on market ${market.marketId}` +
      ` | target size change: ${delta.sizeChangeBase.toFixed(4)}` +
      ` | our size: ${sizeBase.toFixed(4)}` +
      ` | ratio: ${this.config.sizeRatio}` +
      (slippage > this.config.maxSlippage ? ` | WARNING: slippage ${(slippage * 100).toFixed(2)}% exceeds max` : "");

    return {
      marketId: market.marketId,
      tokenId: market.tokenId,
      isIsolatedOnly: market.isIsolatedOnly,
      side: delta.side,
      action,
      orderIntent,
      edgeBps: 0, // Copy trades don't have edge-based logic
      netEdgeBps: 0,
      targetApr: delta.targetEntryApr,
      orderTick,
      orderApr,
      sizeBase,
      sizeBase18,
      notionalUsd: finalNotionalUsd,
      plannedMarginUsd: simulation.marginRequiredUsd,
      simulation,
      rationale,
    };
  }

  isWithinSlippage(delta: TargetPositionDelta, orderApr: number): boolean {
    return Math.abs(orderApr - delta.targetEntryApr) <= this.config.maxSlippage;
  }
}
