import { randomUUID } from "node:crypto";
import type { BorosApiClient } from "./borosApi.js";
import type { TraderConfig } from "./config.js";
import { CopyExecutor } from "./copyExecution.js";
import type { RuntimeStore } from "./db.js";
import type { Broker } from "./execution.js";
import { LiveBroker, PaperBroker } from "./execution.js";
import { TargetWatcher } from "./targetWatcher.js";
import type { CopyPosition, CopyTradeRecord, ExecutionRecord, MarketSummary, TargetPositionDelta, TargetPositionSnapshot, TradeCandidate } from "./types.js";

export class CopyTrader {
  private readonly watcher: TargetWatcher;
  private readonly executor: CopyExecutor;
  private readonly broker: Broker;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private processing: Promise<void> | null = null;
  private marketCache: Map<number, MarketSummary> = new Map();
  private lastMarketFetch = 0;
  private pollCount = 0;
  private lastHeartbeat = 0;
  private startedAt = Date.now();
  private failureStreak = 0;
  private dailyPnlUsd = 0;
  private dailyBaselineDate = new Date().toISOString().slice(0, 10);
  private pendingOrderIds: string[] = [];

  constructor(
    private readonly config: TraderConfig,
    private readonly api: BorosApiClient,
    private readonly store: RuntimeStore,
  ) {
    this.broker = config.mode === "live"
      ? new LiveBroker(config)
      : new PaperBroker(config);

    this.watcher = new TargetWatcher(
      config.copyTrade.targetAddress,
      config.copyTrade.targetAccountId ?? 0,
      api,
      config.copyTrade.deltaDeadzone,
    );

    this.executor = new CopyExecutor(config.copyTrade, api);
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[copy-trade] starting | mode=${this.config.mode} target=${this.config.copyTrade.targetAddress} polling=${this.config.copyTrade.pollingMs}ms`);

    // Discover account ID if not provided
    if (this.config.copyTrade.targetAccountId === undefined) {
      console.log("[copy-trade] no target account ID specified, running discovery...");
      const ids = await this.watcher.discoverAccountIds();
      if (ids.length === 0) {
        console.error("[copy-trade] no active accounts found for target address");
        return;
      }
      console.log(`[copy-trade] discovered active account IDs: ${ids.join(", ")} (using first: ${ids[0]})`);
      this.watcher.setAccountId(ids[0]);
    }

    // Recover previous snapshot from DB to prevent false ENTER deltas on restart
    const savedSnapshot = this.store.getLatestTargetSnapshot(this.config.copyTrade.targetAddress);
    if (savedSnapshot.length > 0) {
      this.watcher.hydrateFromSnapshot(savedSnapshot);
      console.log(`[copy-trade] hydrated ${savedSnapshot.length} position(s) from last saved snapshot`);
    }

    // Initial snapshot (no action on first poll)
    try {
      const { positions } = await this.watcher.poll();
      console.log(`[copy-trade] initial snapshot: ${positions.length} active position(s)`);
      for (const pos of positions) {
        console.log(`  - market=${pos.marketId} side=${pos.side} size=${pos.sizeBase.toFixed(4)} apr=${(pos.entryApr * 100).toFixed(2)}%`);
      }
    } catch (error) {
      console.error("[copy-trade] failed to fetch initial snapshot:", error);
    }

    // Start polling
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => {
        console.error("[copy-trade] cycle error:", error);
      });
    }, this.config.copyTrade.pollingMs);
  }

  async runOnce(): Promise<void> {
    this.processing = this._runOnceImpl();
    try {
      await this.processing;
    } finally {
      this.processing = null;
    }
  }

  private async _runOnceImpl(): Promise<void> {
    if (!this.running) return;

    this.resetDailyCountersIfNeeded();
    const killSwitch = this.checkCopyKillSwitch();
    if (killSwitch.active) {
      console.log(`[copy-trade] kill switch active: ${killSwitch.reason}`);
      this.store.appendKillSwitchEvent(killSwitch.reason!, { source: "copy-trade", failureStreak: this.failureStreak });
      return;
    }

    const { positions, deltas } = await this.watcher.poll();
    this.store.saveTargetSnapshot(this.config.copyTrade.targetAddress, positions);
    this.pollCount++;

    // Heartbeat every 60 seconds
    const now = Date.now();
    if (now - this.lastHeartbeat >= 60_000) {
      const uptime = Math.floor((now - this.startedAt) / 1000);
      const mins = Math.floor(uptime / 60);
      const secs = uptime % 60;
      console.log(`[copy-trade] heartbeat | uptime=${mins}m${secs}s polls=${this.pollCount} positions=${positions.length} deltas=${deltas.length}`);
      this.lastHeartbeat = now;
    }

    if (deltas.length === 0) {
      return;
    }

    console.log(`[copy-trade] detected ${deltas.length} position change(s)`);

    // Refresh market cache if stale (every 5 minutes)
    if (now - this.lastMarketFetch > 300_000) {
      try {
        const markets = await this.api.fetchMarkets();
        this.marketCache.clear();
        for (const m of markets) {
          this.marketCache.set(m.marketId, m);
        }
        this.lastMarketFetch = now;
      } catch (error) {
        console.error("[copy-trade] failed to refresh markets:", error);
      }
    }

    const processedRecords: CopyTradeRecord[] = [];

    for (let i = 0; i < deltas.length; i++) {
      if (i > 0) {
        await new Promise(r => setTimeout(r, this.config.copyTrade.delayBetweenOrdersMs));
      }
      const delta = deltas[i];

      // Block ENTER/INCREASE deltas if at max concurrent positions
      if ((delta.action === "ENTER" || delta.action === "INCREASE") && this.store.getOpenCopyPositions().length >= this.config.copyTrade.maxConcurrentPositions) {
        const record: CopyTradeRecord = {
          id: randomUUID(),
          deltaAction: delta.action,
          targetMarketId: delta.marketId,
          targetSide: delta.side,
          targetSizeBase: delta.targetNewSizeBase,
          ourSizeBase: 0,
          status: "SKIPPED",
          reason: "max concurrent positions reached",
          timestamp: Math.floor(Date.now() / 1000),
        };
        console.log(`[copy-trade] SKIP ${delta.action} market=${delta.marketId}: ${record.reason}`);
        this.store.saveCopyTradeRecord(record);
        await this.sendDiscordAlert(record, delta);
        processedRecords.push(record);
        continue;
      }

      const record = await this.processDelta(delta);

      // Track failure streak
      if (record.status === "EXECUTED") {
        this.failureStreak = 0;
        if (record.ourClientOrderId) {
          this.pendingOrderIds.push(record.ourClientOrderId);
        }
      } else if (record.status === "FAILED") {
        this.failureStreak++;
      }

      this.store.saveCopyTradeRecord(record);
      await this.sendDiscordAlert(record, delta);
      processedRecords.push(record);
    }

    // Reconcile pending orders (live mode only)
    if (this.config.mode === "live" && this.pendingOrderIds.length > 0) {
      try {
        const activeOrders = this.store.getActiveOrders()
          .filter(o => this.pendingOrderIds.includes(o.clientOrderId));
        if (activeOrders.length > 0) {
          const result = await this.broker.reconcile(activeOrders);
          for (const order of result.orders) {
            this.store.saveOrder(order);
          }
          for (const note of result.notes) {
            console.log(`[copy-trade] reconcile: ${note}`);
          }
        }
        // Clean up settled IDs
        const stillActive = this.store.getActiveOrders().map(o => o.clientOrderId);
        this.pendingOrderIds = this.pendingOrderIds.filter(id => stillActive.includes(id));
      } catch (error) {
        console.error("[copy-trade] reconciliation error:", error);
      }
    }

    // Sweep isolated cash after exits (live mode only)
    if (this.config.mode === "live") {
      const exitedIsolatedMarkets = processedRecords
        .filter(r => r.status === "EXECUTED" && (r.deltaAction === "EXIT" || r.deltaAction === "DECREASE"))
        .map(r => this.marketCache.get(r.targetMarketId))
        .filter((m): m is MarketSummary => m !== undefined && m.isIsolatedOnly)
        .map(m => ({ marketId: m.marketId, tokenId: m.tokenId }));

      if (exitedIsolatedMarkets.length > 0) {
        try {
          const notes = await this.broker.sweepIsolatedCash(exitedIsolatedMarkets);
          for (const note of notes) {
            console.log(`[copy-trade] ${note}`);
          }
        } catch (error) {
          console.error("[copy-trade] isolated cash sweep error:", error);
        }
      }
    }

    this.logDriftWarnings(positions);

    if (processedRecords.length > 0) {
      await this.sendCycleSummary(deltas, processedRecords, positions.length);
    }
  }

  private checkCopyKillSwitch(): { active: boolean; reason?: string } {
    if (this.failureStreak >= this.config.copyTrade.maxFailureStreak) {
      return { active: true, reason: "max failure streak exceeded" };
    }
    return { active: false };
  }

  private resetDailyCountersIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyBaselineDate) {
      this.dailyPnlUsd = 0;
      this.dailyBaselineDate = today;
    }
  }

  private async executeWithRetry(candidate: TradeCandidate, maxRetries = 3): Promise<ExecutionRecord> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.broker.execute(candidate);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const msg = lastError.message;

        if (msg.includes("ORDER_VALUE_TOO_LOW") && attempt < maxRetries) {
          // Double the size and retry
          candidate = { ...candidate, sizeBase: candidate.sizeBase * 2, sizeBase18: candidate.sizeBase18 * 2n, notionalUsd: candidate.notionalUsd * 2 };
          console.log(`[copy-trade] retry ${attempt}/${maxRetries}: ORDER_VALUE_TOO_LOW, doubling size to ${candidate.sizeBase.toFixed(4)}`);
          continue;
        }

        if (attempt < maxRetries) {
          const waitMs = 1000 * attempt;
          console.log(`[copy-trade] retry ${attempt}/${maxRetries}: ${msg}, waiting ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
      }
    }
    throw lastError ?? new Error("executeWithRetry exhausted retries");
  }

  private async processDelta(delta: TargetPositionDelta): Promise<CopyTradeRecord> {
    const recordId = randomUUID();
    const market = this.marketCache.get(delta.marketId);

    if (!market) {
      console.log(`[copy-trade] SKIP ${delta.action} market=${delta.marketId}: market data not found`);
      return {
        id: recordId,
        deltaAction: delta.action,
        targetMarketId: delta.marketId,
        targetSide: delta.side,
        targetSizeBase: delta.targetNewSizeBase,
        ourSizeBase: 0,
        status: "SKIPPED",
        reason: "Market data not found in cache",
        timestamp: Math.floor(Date.now() / 1000),
      };
    }

    try {
      const candidate = await this.executor.buildCopyCandidate(delta, market);

      // Check slippage
      if (!this.executor.isWithinSlippage(delta, candidate.orderApr)) {
        const reason = `APR slippage too high: order=${candidate.orderApr.toFixed(4)} target=${delta.targetEntryApr.toFixed(4)} max=${this.config.copyTrade.maxSlippage}`;
        console.log(`[copy-trade] SKIP ${delta.action} market=${delta.marketId}: ${reason}`);
        return {
          id: recordId,
          deltaAction: delta.action,
          targetMarketId: delta.marketId,
          targetSide: delta.side,
          targetSizeBase: delta.targetNewSizeBase,
          ourSizeBase: candidate.sizeBase,
          status: "SKIPPED",
          reason,
          timestamp: Math.floor(Date.now() / 1000),
        };
      }

      console.log(`[copy-trade] EXECUTE ${delta.action} ${delta.side} market=${delta.marketId} size=${candidate.sizeBase.toFixed(4)} apr=${candidate.orderApr.toFixed(4)}`);
      const executionRecord = await this.executeWithRetry(candidate);

      // Track copy position
      if (delta.action === "ENTER" || delta.action === "INCREASE") {
        const posId = `copy:${delta.marketId}:${delta.side}`;
        this.store.upsertCopyPosition({
          id: posId,
          marketId: delta.marketId,
          side: delta.side,
          sizeBase: candidate.sizeBase,
          sizeBase18: candidate.sizeBase18.toString(),
          entryApr: candidate.orderApr,
          notionalUsd: candidate.notionalUsd,
          marginUsd: candidate.plannedMarginUsd,
          status: "OPEN",
          openedAt: Math.floor(Date.now() / 1000),
          clientOrderId: executionRecord.clientOrderId,
        });
      } else if (delta.action === "EXIT" || delta.action === "DECREASE") {
        const posId = `copy:${delta.marketId}:${delta.side}`;
        this.store.closeCopyPosition(posId);
      }

      return {
        id: recordId,
        deltaAction: delta.action,
        targetMarketId: delta.marketId,
        targetSide: delta.side,
        targetSizeBase: delta.targetNewSizeBase,
        ourClientOrderId: executionRecord.clientOrderId,
        ourSizeBase: candidate.sizeBase,
        status: "EXECUTED",
        timestamp: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const isBelowMinimum = reason.includes("below $") && reason.includes("minimum");
      const status = isBelowMinimum ? "SKIPPED" as const : "FAILED" as const;
      const logFn = isBelowMinimum ? console.log : console.error;
      const label = isBelowMinimum ? "SKIP" : "FAIL";
      logFn(`[copy-trade] ${label} ${delta.action} market=${delta.marketId}: ${reason}`);
      return {
        id: recordId,
        deltaAction: delta.action,
        targetMarketId: delta.marketId,
        targetSide: delta.side,
        targetSizeBase: delta.targetNewSizeBase,
        ourSizeBase: 0,
        status,
        reason,
        timestamp: Math.floor(Date.now() / 1000),
      };
    }
  }

  private logDriftWarnings(targetPositions: TargetPositionSnapshot[]): void {
    const openCopyPositions = this.store.getOpenCopyPositions();
    const targetMarketIds = new Set(targetPositions.map(p => p.marketId));
    const copyMarketIds = new Set(openCopyPositions.map(p => p.marketId));

    for (const pos of openCopyPositions) {
      if (!targetMarketIds.has(pos.marketId)) {
        console.log(`[copy-trade] DRIFT: we have open position on market ${pos.marketId} but target does not`);
      }
    }
    for (const pos of targetPositions) {
      if (!copyMarketIds.has(pos.marketId)) {
        console.log(`[copy-trade] DRIFT: target has position on market ${pos.marketId} but we do not`);
      }
    }
  }

  private async sendCycleSummary(
    deltas: TargetPositionDelta[],
    records: CopyTradeRecord[],
    targetPositionCount: number,
  ): Promise<void> {
    const webhookUrl = this.config.copyTrade.discordWebhookUrl;
    if (!webhookUrl) return;

    const executed = records.filter(r => r.status === "EXECUTED").length;
    const skipped = records.filter(r => r.status === "SKIPPED").length;
    const failed = records.filter(r => r.status === "FAILED").length;
    const uptime = Math.floor((Date.now() - this.startedAt) / 1000);
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;

    const embed = {
      title: "Copy Trade Cycle Summary",
      color: failed > 0 ? 0xff0000 : executed > 0 ? 0x00ff00 : 0xffaa00,
      fields: [
        { name: "Total Deltas", value: String(deltas.length), inline: true },
        { name: "Executed", value: String(executed), inline: true },
        { name: "Skipped", value: String(skipped), inline: true },
        { name: "Failed", value: String(failed), inline: true },
        { name: "Target Positions", value: String(targetPositionCount), inline: true },
        { name: "Uptime", value: `${mins}m${secs}s`, inline: true },
        { name: "Poll Count", value: String(this.pollCount), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
    } catch (error) {
      console.error("[copy-trade] discord cycle summary failed:", error);
    }
  }

  private async sendDiscordAlert(record: CopyTradeRecord, delta: TargetPositionDelta): Promise<void> {
    const webhookUrl = this.config.copyTrade.discordWebhookUrl;
    if (!webhookUrl) return;

    const colorMap = {
      EXECUTED: 0x00ff00,
      SKIPPED: 0xffaa00,
      FAILED: 0xff0000,
    };

    const embed = {
      title: `Copy Trade: ${record.deltaAction} ${record.targetSide}`,
      color: colorMap[record.status],
      fields: [
        { name: "Status", value: record.status, inline: true },
        { name: "Market ID", value: String(record.targetMarketId), inline: true },
        { name: "Side", value: record.targetSide, inline: true },
        { name: "Target Size", value: delta.sizeChangeBase.toFixed(4), inline: true },
        { name: "Our Size", value: record.ourSizeBase.toFixed(4), inline: true },
        { name: "Size Ratio", value: String(this.config.copyTrade.sizeRatio), inline: true },
      ],
      timestamp: new Date(record.timestamp * 1000).toISOString(),
    };

    if (record.reason) {
      embed.fields.push({ name: "Reason", value: record.reason, inline: false });
    }

    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
    } catch (error) {
      console.error("[copy-trade] discord webhook failed:", error);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.processing) {
      const timeout = new Promise<void>(r => setTimeout(r, 30_000));
      await Promise.race([this.processing, timeout]);
    }
    console.log("[copy-trade] stopped");
  }
}
