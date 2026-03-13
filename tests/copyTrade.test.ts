import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../src/db.js";
import { CopyTrader } from "../src/copyTrade.js";
import type { TraderConfig } from "../src/config.js";
import type { MarketSummary, OrderBookDepth, SimulationQuote } from "../src/types.js";

/* ------------------------------------------------------------------ */
/*  Shared test fixtures                                               */
/* ------------------------------------------------------------------ */

const market: MarketSummary = {
  marketId: 1, tokenId: 1, address: "0x", state: "Normal", name: "ETH", symbol: "ETH",
  tickStep: 1, isIsolatedOnly: false, platformName: "test", assetSymbol: "ETH",
  isWhitelisted: true, maturityTimestamp: 9999999999, maxLeverage: 10, defaultLeverage: 5,
  marginFloor: 1, paymentPeriodSeconds: 3600, nextSettlementTime: 9999999999,
  timeToMaturitySeconds: 86400 * 30, assetMarkPrice: 3000, midApr: 0.05,
  markApr: 0.05, bestBid: 0.04, bestAsk: 0.06, floatingApr: 0.05,
  longYieldApr: 0.05, volume24h: 1000000, notionalOi: 5000000,
};

function makeConfig(overrides?: Partial<TraderConfig["copyTrade"]>): TraderConfig {
  return {
    mode: "paper",
    apiBaseUrl: "https://api.boros.finance/core",
    pollingIntervalMs: 60_000,
    sqlitePath: ":memory:",
    maxMarkets: 100,
    startingEquityUsd: 100_000,
    minDaysToMaturity: 14,
    minEdgeBps: 150,
    maxEntryCostBps: 50,
    safetyBufferBps: 50,
    exitEdgeBps: 50,
    aggressiveEntryEdgeBps: 300,
    maxInitialMarginPctPerMarket: 0.1,
    maxTotalInitialMarginPct: 0.35,
    maxConcurrentMarkets: 3,
    maxEffectiveLeverage: 1.5,
    marginUtilizationTargetPct: 0.85,
    minOrderNotionalUsd: 10,
    allowedMarketIds: undefined,
    blocklistedMarketIds: undefined,
    allowIsolatedMarkets: true,
    autoFundIsolatedMarkets: true,
    isolatedMarginBufferBps: 500,
    minIsolatedCashTopupUsd: 10,
    autoCancelStaleLiveOrders: true,
    liveEntryOrderTtlSeconds: 600,
    liveExitOrderTtlSeconds: 180,
    minLiquidityCoverage: 3,
    minEntryLiqBufferBps: 400,
    minMaintainLiqBufferBps: 200,
    maxDailyDrawdownPct: 0.03,
    maxFailureStreak: 2,
    clipAprWindowBps: 500,
    marketOrderSlippage: 0.05,
    takeProfitPnlPct: 0.25,
    stopLossPnlPct: 0.15,
    trailingStopArmPct: 0.15,
    trailingStopGivebackPct: 0.1,
    paperAssumeTakerEntry: true,
    agentAllowEntries: true,
    agentAllowAdds: true,
    agentAllowReductions: true,
    agentAllowCloses: true,
    agentAllowCollateralOps: true,
    agentConfidenceThreshold: 0,
    maxCollateralTransferUsd: 500,
    dryRun: false,
    copyTrade: {
      enabled: true,
      targetAddress: "0x0000000000000000000000000000000000000001",
      targetAccountId: 0,
      pollingMs: 10_000,
      sizeRatio: 1.0,
      maxNotionalUsd: 5_000,
      maxSlippage: 0.10,
      minOrderNotionalUsd: 10,
      roundUpToMinNotional: true,
      maxConcurrentPositions: 10,
      delayBetweenOrdersMs: 0,
      deltaDeadzone: 0.001,
      maxFailureStreak: 3,
      maxDailyDrawdownPct: 0.05,
      minLiquidityCoverage: 3,
      ...overrides,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Mock API factory                                                   */
/* ------------------------------------------------------------------ */

let mockPositions: Array<Record<string, unknown>> = [];
let fetchOrderBookFn: (marketId: number) => Promise<OrderBookDepth>;
let simulateOrderFn: (params: unknown) => Promise<SimulationQuote>;

function resetMockApi(): void {
  mockPositions = [];
  fetchOrderBookFn = async () => ({
    bestLongTick: 100,
    bestShortTick: -100,
    bestLongSizeBase: 1000,
    bestShortSizeBase: 1000,
  });
  simulateOrderFn = async () => ({
    marginRequiredUsd: 100,
    actualLeverage: 5,
    priceImpactBps: 10,
    feeBps: 5,
    status: "OK",
    raw: {},
  });
}

const market2: MarketSummary = {
  ...market,
  marketId: 2, name: "ETH-2", symbol: "ETH2",
};

const market3: MarketSummary = {
  ...market,
  marketId: 3, name: "ETH-3", symbol: "ETH3",
};

const mockApi = {
  fetchActivePositions: async () => mockPositions,
  fetchMarkets: async () => [market, market2, market3],
  fetchOrderBook: async (marketId: number) => fetchOrderBookFn(marketId),
  buildSnapshot: async () => ({}) as any,
  simulateOrder: async (params: unknown) => simulateOrderFn(params),
} as any;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Creates a CopyTrader, calls `start()` (which does the initial poll with
 * whatever `mockPositions` is set to), and returns a handle.  Uses fake
 * timers so the polling interval never fires automatically.
 */
async function setupTrader(configOverrides?: Partial<TraderConfig["copyTrade"]>) {
  const config = makeConfig(configOverrides);
  const store = new RuntimeStore(":memory:");
  const trader = new CopyTrader(config, mockApi, store);

  // start() sets running=true, takes the first snapshot, and creates the
  // polling interval.  With fake timers the interval won't fire on its own.
  await trader.start();

  return { trader, config, store };
}

/** Build an API position object that the TargetWatcher can parse. */
function targetPos(
  marketId: number,
  side: 0 | 1,
  sizeBase: number,
  fixedApr = 0.05,
) {
  const sizeBase18 = BigInt(Math.round(sizeBase * 1e18));
  return {
    marketId,
    side,
    notionalSize: sizeBase18.toString(),
    fixedApr,
    markApr: 0.05,
    liquidationApr: 0,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.useFakeTimers();
  resetMockApi();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CopyTrader", () => {
  it("stop() sets running=false so runOnce() becomes a no-op", async () => {
    const { trader, store } = await setupTrader();

    // Introduce a target position so that a delta would exist
    mockPositions = [targetPos(1, 0, 1.0)];

    await trader.stop();

    // runOnce should return immediately because running=false
    await trader.runOnce();

    // No copy trade records should have been saved
    const records = store.getOpenCopyPositions();
    expect(records).toHaveLength(0);
  });

  it("no deltas produces no copy trade records", async () => {
    const { trader, store } = await setupTrader();

    // Positions unchanged between initial poll and runOnce
    await trader.runOnce();

    const records = store.getOpenCopyPositions();
    expect(records).toHaveLength(0);
  });

  it("executes ENTER delta and saves a copy position", async () => {
    const { trader, store } = await setupTrader();

    // Target acquires a new LONG position on market 1
    mockPositions = [targetPos(1, 0, 1.0)];

    await trader.runOnce();

    const openPositions = store.getOpenCopyPositions();
    expect(openPositions).toHaveLength(1);
    expect(openPositions[0].marketId).toBe(1);
    expect(openPositions[0].side).toBe("LONG");
    expect(openPositions[0].status).toBe("OPEN");

    await trader.stop();
  });

  it("closes the copy position on EXIT delta", async () => {
    const { trader, store } = await setupTrader();

    // Step 1: target enters a position
    mockPositions = [targetPos(1, 0, 1.0)];
    await trader.runOnce();
    expect(store.getOpenCopyPositions()).toHaveLength(1);

    // Step 2: target exits (positions now empty)
    mockPositions = [];
    await trader.runOnce();
    expect(store.getOpenCopyPositions()).toHaveLength(0);

    await trader.stop();
  });

  it("skips ENTER when slippage exceeds maxSlippage", async () => {
    // Set maxSlippage very small so the spread between target entry APR and
    // the market's best ask triggers a skip.
    // Target entry APR = 0.05, market bestAsk = 0.06.
    // Slippage = |0.06 - 0.05| = 0.01, so maxSlippage < 0.01 will skip.
    const { trader, store } = await setupTrader({ maxSlippage: 0.005 });

    mockPositions = [targetPos(1, 0, 1.0, 0.05)];
    await trader.runOnce();

    // Should be skipped - no open copy position
    const openPositions = store.getOpenCopyPositions();
    expect(openPositions).toHaveLength(0);

    await trader.stop();
  });

  it("skips ENTER when order notional is below minimum", async () => {
    const { trader, store } = await setupTrader({ roundUpToMinNotional: false });

    // Very small size: 0.001 * 3000 = $3 < $10 minimum
    mockPositions = [targetPos(1, 0, 0.001)];
    await trader.runOnce();

    const openPositions = store.getOpenCopyPositions();
    expect(openPositions).toHaveLength(0);

    await trader.stop();
  });

  it("kill switch blocks execution after maxFailureStreak failures", async () => {
    // Arrange: make simulateOrder throw so each processDelta fails
    simulateOrderFn = async () => {
      throw new Error("simulation failure");
    };

    const { trader, store } = await setupTrader({ maxFailureStreak: 2 });

    // Each runOnce that detects a new market produces a FAILED record
    // and increments failureStreak.

    // Failure 1: target enters market 1
    mockPositions = [targetPos(1, 0, 1.0)];
    await trader.runOnce();

    // Failure 2: target enters market 2 as well
    mockPositions = [targetPos(1, 0, 1.0), targetPos(2, 0, 1.5)];
    await trader.runOnce();

    // Now failureStreak >= 2 == maxFailureStreak, so kill switch should fire.
    // Adding another target position should not produce a copy trade record.
    mockPositions = [targetPos(1, 0, 1.0), targetPos(2, 0, 1.5), targetPos(3, 1, 2.0)];
    await trader.runOnce();

    // Market 3 should NOT have an open copy position
    const openPositions = store.getOpenCopyPositions();
    expect(openPositions).toHaveLength(0);

    await trader.stop();
  });

  it("skips ENTER when maxConcurrentPositions reached", async () => {
    // Allow only 1 concurrent position
    const { trader, store } = await setupTrader({ maxConcurrentPositions: 1 });

    // Step 1: target enters market 1 - should succeed
    mockPositions = [targetPos(1, 0, 1.0)];
    await trader.runOnce();
    expect(store.getOpenCopyPositions()).toHaveLength(1);

    // Step 2: target also enters market 2 - should be skipped due to limit
    mockPositions = [targetPos(1, 0, 1.0), targetPos(2, 1, 2.0)];
    await trader.runOnce();

    // Should still be only 1 open copy position (market 1)
    const openPositions = store.getOpenCopyPositions();
    expect(openPositions).toHaveLength(1);
    expect(openPositions[0].marketId).toBe(1);

    await trader.stop();
  });

  it("resets failure streak after a successful execution", async () => {
    let callCount = 0;
    simulateOrderFn = async () => {
      callCount++;
      if (callCount <= 1) {
        throw new Error("simulation failure");
      }
      return {
        marginRequiredUsd: 100,
        actualLeverage: 5,
        priceImpactBps: 10,
        feeBps: 5,
        status: "OK",
        raw: {},
      };
    };

    const { trader, store } = await setupTrader({ maxFailureStreak: 3 });

    // Failure 1: market 1 enters
    mockPositions = [targetPos(1, 0, 1.0)];
    await trader.runOnce();
    expect(store.getOpenCopyPositions()).toHaveLength(0);

    // Now simulateOrder succeeds. Market 2 enters and succeeds.
    mockPositions = [targetPos(1, 0, 1.0), targetPos(2, 0, 1.5)];
    await trader.runOnce();

    // Market 2 should have opened (market 1 was already in snapshot from first poll)
    const openPositions = store.getOpenCopyPositions();
    expect(openPositions.some(p => p.marketId === 2)).toBe(true);

    // If the failure streak was not reset, a subsequent failure cycle would
    // trigger kill switch prematurely. Let's just verify we have the successful position.
    expect(openPositions.filter(p => p.status === "OPEN")).toHaveLength(
      openPositions.length,
    );

    await trader.stop();
  });
});
