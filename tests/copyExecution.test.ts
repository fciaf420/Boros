import { describe, expect, it } from "vitest";
import type { CopyTradeConfig, MarketSummary, OrderBookDepth, SimulationQuote, TargetPositionDelta } from "../src/types.js";
import { CopyExecutor } from "../src/copyExecution.js";

const config: CopyTradeConfig = {
  enabled: true,
  targetAddress: "0x0000000000000000000000000000000000000000",
  pollingMs: 10000,
  sizeRatio: 1.0,
  maxNotionalUsd: 5000,
  maxSlippage: 0.10,
  minOrderNotionalUsd: 10,
  maxConcurrentPositions: 10,
  delayBetweenOrdersMs: 500,
  deltaDeadzone: 0.001,
  maxFailureStreak: 5,
  maxDailyDrawdownPct: 0.05,
  minLiquidityCoverage: 3,
};

function createMockApi(overrides?: { orderBook?: Partial<OrderBookDepth>; simulation?: Partial<SimulationQuote> }) {
  return {
    fetchOrderBook: async () => ({
      bestLongTick: 100,
      bestShortTick: -100,
      bestLongSizeBase: 1000,
      bestShortSizeBase: 1000,
      ...overrides?.orderBook,
    }),
    simulateOrder: async () => ({
      marginRequiredUsd: 100,
      actualLeverage: 5,
      priceImpactBps: 10,
      feeBps: 5,
      status: "OK",
      raw: {},
      ...overrides?.simulation,
    }),
  } as any;
}

const market: MarketSummary = {
  marketId: 1, tokenId: 1, address: "0x", state: "Normal", name: "ETH", symbol: "ETH",
  tickStep: 1, isIsolatedOnly: false, platformName: "test", assetSymbol: "ETH",
  isWhitelisted: true, maturityTimestamp: 9999999999, maxLeverage: 10, defaultLeverage: 5,
  marginFloor: 1, paymentPeriodSeconds: 3600, nextSettlementTime: 9999999999,
  timeToMaturitySeconds: 86400 * 30, assetMarkPrice: 3000, midApr: 0.05,
  markApr: 0.05, bestBid: 0.04, bestAsk: 0.06, floatingApr: 0.05,
  longYieldApr: 0.05, volume24h: 1000000, notionalOi: 5000000,
};

function makeDelta(overrides?: Partial<TargetPositionDelta>): TargetPositionDelta {
  return {
    action: "ENTER",
    marketId: 1,
    side: "LONG",
    sizeChangeBase: 1.0,
    targetNewSizeBase: 1.0,
    targetEntryApr: 0.05,
    ...overrides,
  };
}

describe("CopyExecutor", () => {
  it("computeCopySize scales target size by sizeRatio", () => {
    const executor = new CopyExecutor({ ...config, sizeRatio: 0.5 }, createMockApi());
    expect(executor.computeCopySize(100)).toBe(50);
  });

  it("caps size when computed notional exceeds maxNotionalUsd", async () => {
    const executor = new CopyExecutor(config, createMockApi());
    // sizeChangeBase=10, assetMarkPrice=3000 => notional=30000 > maxNotionalUsd=5000
    const candidate = await executor.buildCopyCandidate(
      makeDelta({ sizeChangeBase: 10 }),
      market,
    );
    // capped: 5000 / 3000 = 1.6667
    expect(candidate.sizeBase).toBeCloseTo(5000 / 3000, 4);
    expect(candidate.notionalUsd).toBeLessThanOrEqual(5000);
  });

  it("throws when final notional is below minOrderNotionalUsd", async () => {
    // Very small size: 0.001 * 3000 = $3 < $10 minimum
    const executor = new CopyExecutor(config, createMockApi());
    await expect(
      executor.buildCopyCandidate(makeDelta({ sizeChangeBase: 0.001 }), market),
    ).rejects.toThrow("below $");
  });

  it("selects bestAsk as orderApr for LONG side", async () => {
    const executor = new CopyExecutor(config, createMockApi());
    const candidate = await executor.buildCopyCandidate(
      makeDelta({ side: "LONG" }),
      market,
    );
    expect(candidate.orderApr).toBe(market.bestAsk);
  });

  it("selects bestBid as orderApr for SHORT side", async () => {
    const executor = new CopyExecutor(config, createMockApi());
    const candidate = await executor.buildCopyCandidate(
      makeDelta({ side: "SHORT" }),
      market,
    );
    expect(candidate.orderApr).toBe(market.bestBid);
  });

  it("isWithinSlippage returns true when slippage is within maxSlippage", () => {
    const executor = new CopyExecutor(config, createMockApi());
    // targetEntryApr=0.05, orderApr=0.06 => slippage=0.01 <= maxSlippage=0.10
    const delta = makeDelta({ targetEntryApr: 0.05 });
    expect(executor.isWithinSlippage(delta, 0.06)).toBe(true);
  });

  it("isWithinSlippage returns false when slippage exceeds maxSlippage", () => {
    const executor = new CopyExecutor(config, createMockApi());
    // targetEntryApr=0.05, orderApr=0.20 => slippage=0.15 > maxSlippage=0.10
    const delta = makeDelta({ targetEntryApr: 0.05 });
    expect(executor.isWithinSlippage(delta, 0.20)).toBe(false);
  });

  it("caps size to availableLiquidity / minLiquidityCoverage from order book", async () => {
    // For LONG side, available liquidity = bestShortSizeBase = 6
    // liquidityCap = 6 / 3 = 2
    // sizeChangeBase=5, sizeRatio=1 => computed=5 > liquidityCap=2
    // Use a high maxNotionalUsd so the notional cap does not interfere
    const mockApi = createMockApi({ orderBook: { bestShortSizeBase: 6 } });
    const executor = new CopyExecutor({ ...config, maxNotionalUsd: 100_000 }, mockApi);
    const candidate = await executor.buildCopyCandidate(
      makeDelta({ sizeChangeBase: 5 }),
      market,
    );
    expect(candidate.sizeBase).toBeCloseTo(2, 4);
    expect(candidate.notionalUsd).toBeCloseTo(2 * 3000, 4);
  });
});
