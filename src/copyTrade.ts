import { randomUUID } from "node:crypto";
import type { BorosApiClient } from "./borosApi.js";
import type { TraderConfig } from "./config.js";
import { CopyExecutor } from "./copyExecution.js";
import type { RuntimeStore } from "./db.js";
import type { Broker } from "./execution.js";
import { LiveBroker, PaperBroker } from "./execution.js";
import { TargetWatcher } from "./targetWatcher.js";
import type { CopyTradeRecord, MarketSummary, TargetPositionDelta } from "./types.js";

export class CopyTrader {
  private readonly watcher: TargetWatcher;
  private readonly executor: CopyExecutor;
  private readonly broker: Broker;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private marketCache: Map<number, MarketSummary> = new Map();
  private lastMarketFetch = 0;

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
    if (!this.running) return;

    const { positions, deltas } = await this.watcher.poll();
    this.store.saveTargetSnapshot(this.config.copyTrade.targetAddress, positions);

    if (deltas.length === 0) {
      return;
    }

    console.log(`[copy-trade] detected ${deltas.length} position change(s)`);

    // Refresh market cache if stale (every 5 minutes)
    const now = Date.now();
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

    for (const delta of deltas) {
      const record = await this.processDelta(delta);
      this.store.saveCopyTradeRecord(record);
      await this.sendDiscordAlert(record, delta);
    }
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
      const executionRecord = await this.broker.execute(candidate);

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
      console.error(`[copy-trade] FAIL ${delta.action} market=${delta.marketId}: ${reason}`);
      return {
        id: recordId,
        deltaAction: delta.action,
        targetMarketId: delta.marketId,
        targetSide: delta.side,
        targetSizeBase: delta.targetNewSizeBase,
        ourSizeBase: 0,
        status: "FAILED",
        reason,
        timestamp: Math.floor(Date.now() / 1000),
      };
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

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    console.log("[copy-trade] stopped");
  }
}
