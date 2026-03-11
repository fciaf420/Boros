import { describe, expect, it } from "vitest";
import type { TraderConfig } from "../src/config.js";
import { allocateSignalWeightedBudgets, computeRiskState, openPositionPnlPct, openPositionPnlUsd, perMarketMarginBudget, refreshOpenPosition } from "../src/risk.js";
import type { MarketSnapshot, OpenPosition } from "../src/types.js";

const config: TraderConfig = {
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
  dryRun: false,
  copyTrade: {
    enabled: false,
    targetAddress: "0x0000000000000000000000000000000000000000",
    pollingMs: 10_000,
    sizeRatio: 1.0,
    maxNotionalUsd: 5_000,
    maxSlippage: 0.10,
    minOrderNotionalUsd: 10,
    maxConcurrentPositions: 10,
    delayBetweenOrdersMs: 500,
    deltaDeadzone: 0.001,
    maxFailureStreak: 5,
    maxDailyDrawdownPct: 0.05,
    minLiquidityCoverage: 3,
  },
};

function makePosition(): OpenPosition {
  return {
    id: "23:LONG:1",
    marketId: 23,
    tokenId: 1,
    marketName: "BTC",
    assetSymbol: "BTC",
    isIsolatedOnly: false,
    marketAcc: "0xabc",
    side: "LONG",
    status: "OPEN",
    openedAt: 1000,
    entryApr: 0.02,
    currentApr: 0.02,
    fixedApr: 0.02,
    floatingApr: 0.03,
    sizeBase: 1,
    sizeBase18: "1000000000000000000",
    assetMarkPrice: 70_000,
    notionalUsd: 70_000,
    initialMarginUsd: 10_000,
    actualLeverage: 1.2,
    liquidationApr: -0.02,
    liquidationBufferBps: 400,
    addCount: 0,
    realizedCarryPnlUsd: 0,
    realizedTradingPnlUsd: 0,
    unrealizedPnlUsd: 0,
    peakPnlUsd: 0,
    peakPnlPct: 0,
    lastAccrualTs: 1000,
    lastSignalEdgeBps: 150,
  };
}

function makeSnapshot(): MarketSnapshot {
  return {
    recordedAt: 4600,
    market: {
      marketId: 23,
      tokenId: 1,
      address: "0x0",
      state: "Normal",
      name: "BTC",
      symbol: "BTC",
      tickStep: 2,
      isIsolatedOnly: false,
      platformName: "Binance",
      assetSymbol: "BTC",
      isWhitelisted: true,
      maturityTimestamp: 1_800_000_000,
      maxLeverage: 3,
      defaultLeverage: 3,
      marginFloor: 0.06,
      paymentPeriodSeconds: 28_800,
      nextSettlementTime: 1_700_000_000,
      timeToMaturitySeconds: 30 * 24 * 3600,
      assetMarkPrice: 70_000,
      midApr: 0.03,
      markApr: 0.03,
      bestBid: 0.029,
      bestAsk: 0.031,
      floatingApr: 0.04,
      longYieldApr: 0.2,
      volume24h: 100,
      notionalOi: 100,
    },
    orderBook: {},
    indicators: {
      currentUnderlyingApr: 0.04,
      futuresPremium: 0.02,
      underlyingApr7d: 0.03,
      underlyingApr30d: 0.025,
      lastTimestamp: 1_700_000_000,
    },
  };
}

describe("risk state", () => {
  it("updates carry and mark-to-market pnl on an open position", () => {
    const refreshed = refreshOpenPosition(makePosition(), makeSnapshot());
    expect(refreshed.realizedCarryPnlUsd).toBeGreaterThan(0);
    expect(refreshed.unrealizedPnlUsd).toBeGreaterThan(0);
    expect(refreshed.peakPnlUsd).toBeGreaterThan(0);
    expect(refreshed.peakPnlPct).toBeGreaterThan(0);
  });

  it("triggers the kill switch when losses exceed the daily cap", () => {
    const losing = {
      ...makePosition(),
      unrealizedPnlUsd: -5_000,
    };
    const state = computeRiskState(config, [losing], 0, 100_000);
    expect(state.killSwitchActive).toBe(true);
  });

  it("keeps realized pnl from closed positions in equity", () => {
    const closed = {
      ...makePosition(),
      status: "CLOSED" as const,
      unrealizedPnlUsd: 0,
      realizedTradingPnlUsd: 1_250,
    };
    const state = computeRiskState(config, [closed], 0, 100_000);
    expect(state.equityUsd).toBe(101_250);
  });

  it("allocates per-entry budget across remaining slots", () => {
    const first = {
      ...makePosition(),
      initialMarginUsd: 20_000,
    };
    const state = computeRiskState({
      ...config,
      startingEquityUsd: 100_000,
      maxInitialMarginPctPerMarket: 1,
      maxTotalInitialMarginPct: 1,
      maxConcurrentMarkets: 4,
    }, [first], 0, 100_000);
    expect(perMarketMarginBudget({
      ...config,
      startingEquityUsd: 100_000,
      maxInitialMarginPctPerMarket: 1,
      maxTotalInitialMarginPct: 1,
      maxConcurrentMarkets: 4,
    }, state)).toBeCloseTo((100_000 - 20_000) / 3, 8);
  });

  it("weights margin budgets toward stronger entry signals", () => {
    const budgets = allocateSignalWeightedBudgets([
      { key: "64", score: 600 },
      { key: "66", score: 300 },
      { key: "71", score: 100 },
    ], 90, 90, 3);

    expect(budgets.get("64")).toBeCloseTo(54, 8);
    expect(budgets.get("66")).toBeCloseTo(27, 8);
    expect(budgets.get("71")).toBeCloseTo(9, 8);
  });

  it("computes open position pnl and pnl pct from realized plus unrealized", () => {
    const position = {
      ...makePosition(),
      realizedCarryPnlUsd: 50,
      realizedTradingPnlUsd: 25,
      unrealizedPnlUsd: 125,
      initialMarginUsd: 1000,
    };
    expect(openPositionPnlUsd(position)).toBe(200);
    expect(openPositionPnlPct(position)).toBe(0.2);
  });

  it("keeps the peak pnl watermark when pnl pulls back", () => {
    const position = {
      ...makePosition(),
      realizedCarryPnlUsd: 100,
      realizedTradingPnlUsd: 50,
      unrealizedPnlUsd: 25,
      peakPnlUsd: 500,
      peakPnlPct: 0.5,
      initialMarginUsd: 1000,
    };
    const snapshot = {
      ...makeSnapshot(),
      market: {
        ...makeSnapshot().market,
        midApr: 0.0201,
        floatingApr: 0.0202,
      },
    };
    const refreshed = refreshOpenPosition(position, snapshot);
    expect(openPositionPnlPct(refreshed)).toBeLessThan(0.5);
    expect(refreshed.peakPnlUsd).toBe(500);
    expect(refreshed.peakPnlPct).toBe(0.5);
  });
});
