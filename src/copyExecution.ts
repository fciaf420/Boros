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

  /**
   * Build a TradeCandidate from a target position delta.
   *
   * @param delta           The detected change in the target's position.
   * @param market          Current market summary (prices, APRs, order book top).
   * @param existingNotionalUsd  The notional USD already held in this position by the
   *                             copier. For INCREASE (ADD) deltas the caller should pass
   *                             the current position's notionalUsd so the cap is enforced
   *                             cumulatively, not per-delta. Defaults to 0.
   */
  async buildCopyCandidate(
    delta: TargetPositionDelta,
    market: MarketSummary,
    existingNotionalUsd: number = 0,
  ): Promise<TradeCandidate> {
    // Map DeltaAction to ActionType
    const action = delta.action === "ENTER" ? "ENTER"
      : delta.action === "EXIT" ? "EXIT"
      : delta.action === "INCREASE" ? "ADD"
      : "EXIT"; // DECREASE maps to EXIT (partial)

    const isExit = delta.action === "EXIT" || delta.action === "DECREASE";

    if (!market.assetMarkPrice || market.assetMarkPrice <= 0) {
      throw new Error(`Market ${market.marketId} has invalid assetMarkPrice (${market.assetMarkPrice}); skipping`);
    }

    // For ENTER/INCREASE we use the delta's sizeChangeBase; for EXIT/DECREASE we also use sizeChangeBase
    let sizeBase = this.computeCopySize(delta.sizeChangeBase);

    // Apply cumulative notional cap.
    // existingNotionalUsd represents the notional already allocated to this
    // position so that multiple INCREASE deltas cannot exceed maxNotionalUsd.
    const remainingNotional = Math.max(0, this.config.maxNotionalUsd - existingNotionalUsd);
    if (remainingNotional <= 0 && !isExit) {
      throw new Error(
        `Position notional already at cap ($${existingNotionalUsd.toFixed(2)} >= $${this.config.maxNotionalUsd}); skipping INCREASE`,
      );
    }
    const notionalUsd = sizeBase * market.assetMarkPrice;
    if (!isExit && notionalUsd > remainingNotional) {
      sizeBase = remainingNotional / market.assetMarkPrice;
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
        // Add 20% buffer to avoid rounding/precision rejections from the API
        sizeBase = (this.config.minOrderNotionalUsd * 1.20) / market.assetMarkPrice;
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

    // For ENTER/INCREASE, slippage is measured against the target's entry APR
    // (we want to open near the same price the target did).
    // For EXIT/DECREASE, the target's entry APR is stale -- slippage should be
    // measured against the current market mid APR so we evaluate execution
    // quality relative to where the market actually is right now.
    const referenceApr = isExit ? market.midApr : delta.targetEntryApr;

    const slippage = Math.abs(orderApr - referenceApr);
    if (slippage > this.config.maxSlippage) {
      // Still build the candidate but note it in rationale - caller decides to skip
    }

    // Simulate the order for margin/fee data
    // tif=2 is FILL_OR_KILL
    // For isolated markets, simulation may fail if no collateral is deposited yet —
    // in that case we estimate margin and let ensureIsolatedCash() fund it before execution.
    let simulation: Awaited<ReturnType<typeof this.api.simulateOrder>>;
    try {
      simulation = await this.api.simulateOrder({
        marketId: market.marketId,
        side: delta.side,
        sizeBase18,
        tif: 2,
        slippage: this.config.maxSlippage,
      });
    } catch (simError) {
      if (market.isIsolatedOnly) {
        // Estimate margin for isolated markets that aren't funded yet
        const estimatedMargin = finalNotionalUsd / (market.defaultLeverage || 1);
        simulation = {
          marginRequiredUsd: estimatedMargin,
          actualLeverage: market.defaultLeverage || 1,
          liquidationApr: undefined,
          liquidationBufferBps: undefined,
          priceImpactBps: 0,
          feeBps: 0,
          status: "ESTIMATED",
          raw: {},
        };
      } else {
        throw simError;
      }
    }

    const rationale = `Copy trade: ${delta.action} ${delta.side} on market ${market.marketId}` +
      ` | target size change: ${delta.sizeChangeBase.toFixed(4)}` +
      ` | our size: ${sizeBase.toFixed(4)}` +
      ` | ratio: ${this.config.sizeRatio}` +
      (slippage > this.config.maxSlippage ? ` | WARNING: slippage ${(slippage * 100).toFixed(2)}% exceeds max (ref=${referenceApr.toFixed(4)})` : "");

    return {
      marketId: market.marketId,
      tokenId: market.tokenId,
      isIsolatedOnly: market.isIsolatedOnly,
      side: delta.side,
      action,
      orderIntent,
      edgeBps: 0, // Copy trades don't have edge-based logic
      netEdgeBps: 0,
      targetApr: referenceApr,
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

  /**
   * Check whether the order APR is within the allowed slippage of the reference APR.
   *
   * For ENTER/INCREASE the reference is the target's entry APR (we want to
   * match their entry price). For EXIT/DECREASE the reference should be the
   * current market mid APR since the original entry APR is no longer relevant.
   *
   * @param marketMidApr  Current market mid APR -- used as the reference for
   *                      EXIT/DECREASE actions.
   */
  isWithinSlippage(delta: TargetPositionDelta, orderApr: number, marketMidApr?: number): boolean {
    const isExit = delta.action === "EXIT" || delta.action === "DECREASE";
    const referenceApr = isExit && marketMidApr !== undefined ? marketMidApr : delta.targetEntryApr;
    return Math.abs(orderApr - referenceApr) <= this.config.maxSlippage;
  }
}
