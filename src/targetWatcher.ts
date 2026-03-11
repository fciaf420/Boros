import type { BorosApiClient } from "./borosApi.js";
import type { TargetPositionDelta, TargetPositionSnapshot } from "./types.js";

interface ActivePositionResponse {
  marketId: number;
  side: number; // 0 = LONG, 1 = SHORT
  notionalSize: string;
  fixedApr: number;
  markApr: number;
  liquidationApr: number;
  positionValue?: { settledPosition?: string; remainingPosition?: string };
}

export class TargetWatcher {
  private previousSnapshot: Map<number, TargetPositionSnapshot> = new Map();
  private resolvedAccountId: number;
  private readonly deadzone: number;

  constructor(
    private readonly targetAddress: string,
    initialAccountId: number,
    private readonly api: BorosApiClient,
    deadzone = 0.001,
  ) {
    this.resolvedAccountId = initialAccountId;
    this.deadzone = deadzone;
  }

  hydrateFromSnapshot(positions: TargetPositionSnapshot[]): void {
    this.previousSnapshot = new Map();
    for (const pos of positions) {
      this.previousSnapshot.set(pos.marketId, pos);
    }
  }

  setAccountId(id: number): void {
    this.resolvedAccountId = id;
  }

  async fetchTargetPositions(): Promise<TargetPositionSnapshot[]> {
    const data = await this.api.fetchActivePositions(this.targetAddress, this.resolvedAccountId);

    return data
      .filter((pos) => {
        const raw = String(pos.notionalSize ?? "0").replace(/[^0-9\-]/g, "");
        return raw !== "0" && raw !== "";
      })
      .map((pos): TargetPositionSnapshot => {
        const raw = String(pos.notionalSize ?? "0").replace(/[^0-9\-]/g, "");
        const notionalRaw = BigInt(raw || "0");
        const absNotional = notionalRaw < 0n ? -notionalRaw : notionalRaw;
        const sizeBase = Number(absNotional) / 1e18;
        const side = Number(pos.side) === 0 ? "LONG" as const : "SHORT" as const;
        return {
          marketId: Number(pos.marketId),
          side,
          sizeBase,
          sizeBase18: absNotional.toString(),
          entryApr: Number(pos.fixedApr ?? 0),
          currentApr: Number(pos.markApr ?? 0),
        };
      });
  }

  diffSnapshots(
    prev: Map<number, TargetPositionSnapshot>,
    current: TargetPositionSnapshot[],
  ): TargetPositionDelta[] {
    const deltas: TargetPositionDelta[] = [];
    const currentMap = new Map<number, TargetPositionSnapshot>();

    for (const pos of current) {
      currentMap.set(pos.marketId, pos);
      const prevPos = prev.get(pos.marketId);

      if (!prevPos) {
        deltas.push({
          action: "ENTER",
          marketId: pos.marketId,
          side: pos.side,
          sizeChangeBase: pos.sizeBase,
          targetNewSizeBase: pos.sizeBase,
          targetEntryApr: pos.entryApr,
        });
      } else if (prevPos.side !== pos.side) {
        deltas.push({
          action: "EXIT",
          marketId: pos.marketId,
          side: prevPos.side,
          sizeChangeBase: prevPos.sizeBase,
          targetNewSizeBase: 0,
          targetEntryApr: prevPos.entryApr,
        });
        deltas.push({
          action: "ENTER",
          marketId: pos.marketId,
          side: pos.side,
          sizeChangeBase: pos.sizeBase,
          targetNewSizeBase: pos.sizeBase,
          targetEntryApr: pos.entryApr,
        });
      } else if (pos.sizeBase > prevPos.sizeBase * (1 + this.deadzone)) {
        deltas.push({
          action: "INCREASE",
          marketId: pos.marketId,
          side: pos.side,
          sizeChangeBase: pos.sizeBase - prevPos.sizeBase,
          targetNewSizeBase: pos.sizeBase,
          targetEntryApr: pos.entryApr,
        });
      } else if (pos.sizeBase < prevPos.sizeBase * (1 - this.deadzone)) {
        deltas.push({
          action: "DECREASE",
          marketId: pos.marketId,
          side: pos.side,
          sizeChangeBase: prevPos.sizeBase - pos.sizeBase,
          targetNewSizeBase: pos.sizeBase,
          targetEntryApr: pos.entryApr,
        });
      }
    }

    for (const [marketId, prevPos] of prev) {
      if (!currentMap.has(marketId)) {
        deltas.push({
          action: "EXIT",
          marketId,
          side: prevPos.side,
          sizeChangeBase: prevPos.sizeBase,
          targetNewSizeBase: 0,
          targetEntryApr: prevPos.entryApr,
        });
      }
    }

    return deltas;
  }

  async poll(): Promise<{
    positions: TargetPositionSnapshot[];
    deltas: TargetPositionDelta[];
  }> {
    const positions = await this.fetchTargetPositions();
    const deltas = this.diffSnapshots(this.previousSnapshot, positions);

    this.previousSnapshot = new Map();
    for (const pos of positions) {
      this.previousSnapshot.set(pos.marketId, pos);
    }

    return { positions, deltas };
  }

  async discoverAccountIds(): Promise<number[]> {
    const activeIds: number[] = [];
    for (let id = 0; id <= 9; id++) {
      try {
        const positions = await this.api.fetchActivePositions(this.targetAddress, id);
        const hasActive = positions.some((pos) => {
          const raw = String(pos.notionalSize ?? "0").replace(/[^0-9\-]/g, "");
          return raw !== "0" && raw !== "";
        });

        if (hasActive) {
          activeIds.push(id);
        }
      } catch {
        // Skip accounts that error
      }
    }
    return activeIds;
  }
}
