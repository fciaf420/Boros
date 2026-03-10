import { describe, expect, it } from "vitest";
import { estimateFairValue } from "../src/strategy.js";
import type { MarketSnapshot } from "../src/types.js";

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    recordedAt: 1,
    market: {
      marketId: 23,
      tokenId: 1,
      address: "0x0",
      state: "Normal",
      name: "Binance BTCUSDT 27 Mar 2026",
      symbol: "BINANCE-BTCUSDT-27MAR2026",
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
      midApr: 0.02,
      markApr: 0.02,
      bestBid: 0.019,
      bestAsk: 0.021,
      floatingApr: 0.01,
      longYieldApr: 0.05,
      volume24h: 100,
      notionalOi: 200,
    },
    orderBook: {
      bestLongTick: 19,
      bestShortTick: 21,
      bestLongSizeBase: 5,
      bestShortSizeBase: 5,
    },
    indicators: {
      currentUnderlyingApr: 0.018,
      futuresPremium: 0.022,
      underlyingApr7d: 0.019,
      underlyingApr30d: 0.021,
      lastTimestamp: 1_700_000_000,
    },
    ...overrides,
  };
}

describe("estimateFairValue", () => {
  it("uses the clipped median of the four input sources", () => {
    const estimate = estimateFairValue(makeSnapshot(), 500);
    expect(estimate.fairApr).toBe(0.02);
    expect(estimate.edgeBpsLong).toBe(0);
    expect(estimate.edgeBpsShort).toBe(0);
  });

  it("clips extreme outliers relative to the current mid APR", () => {
    const snapshot = makeSnapshot({
      indicators: {
        currentUnderlyingApr: 0.15,
        futuresPremium: 0.021,
        underlyingApr7d: 0.019,
        underlyingApr30d: 0.018,
        lastTimestamp: 1,
      },
    });
    const estimate = estimateFairValue(snapshot, 500);
    expect(estimate.clippedSources[0]).toBe(0.07);
    expect(estimate.fairApr).toBe(0.02);
  });
});
