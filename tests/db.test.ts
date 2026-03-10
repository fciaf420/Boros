import { describe, expect, it } from "vitest";
import { RuntimeStore } from "../src/db.js";
import type { ExecutionRecord, TradeCandidate } from "../src/types.js";

describe("RuntimeStore", () => {
  it("persists candidate JSON with bigint fields", () => {
    const store = new RuntimeStore(":memory:");
    const candidate: TradeCandidate = {
      marketId: 1,
      tokenId: 1,
      isIsolatedOnly: false,
      side: "LONG",
      action: "ENTER",
      orderIntent: "maker",
      edgeBps: 200,
      netEdgeBps: 160,
      targetApr: 0.05,
      orderTick: 10,
      orderApr: 0.04,
      sizeBase: 1,
      sizeBase18: 1000000000000000000n,
      notionalUsd: 1000,
      plannedMarginUsd: 100,
      simulation: {
        marginRequiredUsd: 100,
        actualLeverage: 1,
        priceImpactBps: 10,
        feeBps: 5,
        status: "success",
        raw: {},
      },
      rationale: "test",
    };

    expect(() => {
      store.saveSignal({
        marketId: 1,
        fairApr: 0.05,
        sources: [0.05],
        clippedSources: [0.05],
        edgeBpsLong: 200,
        edgeBpsShort: -200,
      }, candidate);
    }).not.toThrow();
  });

  it("persists and reloads active live orders", () => {
    const store = new RuntimeStore(":memory:");
    const candidate: TradeCandidate = {
      marketId: 7,
      tokenId: 1,
      isIsolatedOnly: true,
      side: "SHORT",
      action: "ENTER",
      orderIntent: "maker",
      edgeBps: 250,
      netEdgeBps: 190,
      targetApr: 0.02,
      orderTick: 12,
      orderApr: 0.025,
      sizeBase: 2,
      sizeBase18: 2000000000000000000n,
      notionalUsd: 1000,
      plannedMarginUsd: 120,
      simulation: {
        marginRequiredUsd: 120,
        actualLeverage: 1.1,
        priceImpactBps: 10,
        feeBps: 5,
        status: "success",
        raw: {},
      },
      rationale: "test order",
    };
    const order: ExecutionRecord = {
      clientOrderId: "test-order-1",
      mode: "live",
      candidate,
      status: "OPEN",
      fillApr: 0.025,
      executedAt: 1_700_000_000,
      externalOrderId: "42",
      marketAcc: "0xabc",
      requestedSizeBase18: "2000000000000000000",
      placedSizeBase18: "2000000000000000000",
      filledSizeBase18: "0",
      remainingSizeBase18: "2000000000000000000",
      appliedSizeBase18: "0",
      lastReconciledAt: 1_700_000_000,
      notes: "pending",
    };

    store.saveOrder(order);
    const [saved] = store.getActiveOrders();

    expect(saved.clientOrderId).toBe(order.clientOrderId);
    expect(saved.status).toBe("OPEN");
    expect(saved.candidate.sizeBase18).toBe(2000000000000000000n);
    expect(saved.marketAcc).toBe("0xabc");
  });
});
