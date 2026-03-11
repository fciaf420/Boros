import { describe, expect, it } from "vitest";
import { TargetWatcher } from "../src/targetWatcher.js";
import type { TargetPositionSnapshot } from "../src/types.js";

const mockApi = {
  fetchActivePositions: async () => [],
  fetchMarkets: async () => [],
  fetchOrderBook: async () => ({}),
  buildSnapshot: async () => ({} as any),
  simulateOrder: async () => ({} as any),
} as any;

function makePosition(overrides: Partial<TargetPositionSnapshot> = {}): TargetPositionSnapshot {
  return {
    marketId: 1,
    side: "LONG",
    sizeBase: 100,
    sizeBase18: "100000000000000000000",
    entryApr: 0.05,
    currentApr: 0.06,
    ...overrides,
  };
}

describe("TargetWatcher", () => {
  it("detects ENTER when position is new", () => {
    const watcher = new TargetWatcher("0xabc", 0, mockApi);
    const prev = new Map<number, TargetPositionSnapshot>();
    const current = [makePosition()];
    const deltas = watcher.diffSnapshots(prev, current);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].action).toBe("ENTER");
    expect(deltas[0].marketId).toBe(1);
    expect(deltas[0].side).toBe("LONG");
    expect(deltas[0].sizeChangeBase).toBe(100);
    expect(deltas[0].targetNewSizeBase).toBe(100);
  });

  it("detects EXIT when position is removed", () => {
    const watcher = new TargetWatcher("0xabc", 0, mockApi);
    const pos = makePosition();
    const prev = new Map<number, TargetPositionSnapshot>([[pos.marketId, pos]]);
    const current: TargetPositionSnapshot[] = [];
    const deltas = watcher.diffSnapshots(prev, current);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].action).toBe("EXIT");
    expect(deltas[0].marketId).toBe(1);
    expect(deltas[0].side).toBe("LONG");
    expect(deltas[0].sizeChangeBase).toBe(100);
    expect(deltas[0].targetNewSizeBase).toBe(0);
  });

  it("detects INCREASE when current size exceeds prev by more than deadzone", () => {
    const watcher = new TargetWatcher("0xabc", 0, mockApi);
    const prevPos = makePosition({ sizeBase: 100 });
    const prev = new Map<number, TargetPositionSnapshot>([[prevPos.marketId, prevPos]]);
    const current = [makePosition({ sizeBase: 120 })];
    const deltas = watcher.diffSnapshots(prev, current);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].action).toBe("INCREASE");
    expect(deltas[0].sizeChangeBase).toBeCloseTo(20);
    expect(deltas[0].targetNewSizeBase).toBe(120);
  });

  it("detects DECREASE when current size is below prev by more than deadzone", () => {
    const watcher = new TargetWatcher("0xabc", 0, mockApi);
    const prevPos = makePosition({ sizeBase: 100 });
    const prev = new Map<number, TargetPositionSnapshot>([[prevPos.marketId, prevPos]]);
    const current = [makePosition({ sizeBase: 80 })];
    const deltas = watcher.diffSnapshots(prev, current);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].action).toBe("DECREASE");
    expect(deltas[0].sizeChangeBase).toBeCloseTo(20);
    expect(deltas[0].targetNewSizeBase).toBe(80);
  });

  it("detects side-flip as EXIT + ENTER", () => {
    const watcher = new TargetWatcher("0xabc", 0, mockApi);
    const prevPos = makePosition({ side: "LONG", sizeBase: 100 });
    const prev = new Map<number, TargetPositionSnapshot>([[prevPos.marketId, prevPos]]);
    const current = [makePosition({ side: "SHORT", sizeBase: 50 })];
    const deltas = watcher.diffSnapshots(prev, current);
    expect(deltas).toHaveLength(2);
    expect(deltas[0].action).toBe("EXIT");
    expect(deltas[0].side).toBe("LONG");
    expect(deltas[0].targetNewSizeBase).toBe(0);
    expect(deltas[1].action).toBe("ENTER");
    expect(deltas[1].side).toBe("SHORT");
    expect(deltas[1].targetNewSizeBase).toBe(50);
  });

  it("produces no delta when size change is within default deadzone", () => {
    const watcher = new TargetWatcher("0xabc", 0, mockApi); // default deadzone = 0.001
    const prevPos = makePosition({ sizeBase: 100 });
    const prev = new Map<number, TargetPositionSnapshot>([[prevPos.marketId, prevPos]]);
    // Change of 0.05% is within the 0.1% deadzone
    const current = [makePosition({ sizeBase: 100.05 })];
    const deltas = watcher.diffSnapshots(prev, current);
    expect(deltas).toHaveLength(0);
  });

  it("produces no delta when size change is within custom deadzone of 1%", () => {
    const watcher = new TargetWatcher("0xabc", 0, mockApi, 0.01); // deadzone = 1%
    const prevPos = makePosition({ sizeBase: 100 });
    const prev = new Map<number, TargetPositionSnapshot>([[prevPos.marketId, prevPos]]);
    // Change of 0.9% is within the 1% deadzone
    const current = [makePosition({ sizeBase: 100.9 })];
    const deltas = watcher.diffSnapshots(prev, current);
    expect(deltas).toHaveLength(0);
  });

  it("hydrateFromSnapshot prevents false ENTER on restart", async () => {
    const positions = [makePosition()];
    const mockApiWithPositions = {
      ...mockApi,
      fetchActivePositions: async () =>
        positions.map((p) => ({
          marketId: p.marketId,
          side: p.side === "LONG" ? 0 : 1,
          notionalSize: p.sizeBase18,
          fixedApr: p.entryApr,
          markApr: p.currentApr,
          liquidationApr: 0,
        })),
    } as any;
    const watcher = new TargetWatcher("0xabc", 0, mockApiWithPositions);
    watcher.hydrateFromSnapshot(positions);
    const { deltas } = await watcher.poll();
    expect(deltas).toHaveLength(0);
  });
});
