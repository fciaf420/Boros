import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CopyTradeRecord, ExecutionRecord, FairValueEstimate, MarketSnapshot, OpenPosition, RiskState, TargetPositionSnapshot, TradeCandidate } from "./types.js";

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, innerValue) =>
    typeof innerValue === "bigint" ? innerValue.toString() : innerValue,
  );
}

export class RuntimeStore {
  private readonly db: Database.Database;

  public constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        market_id INTEGER NOT NULL,
        market_name TEXT NOT NULL,
        asset_symbol TEXT NOT NULL,
        platform_name TEXT NOT NULL,
        mid_apr REAL NOT NULL,
        floating_apr REAL NOT NULL,
        futures_premium REAL,
        underlying_apr_7d REAL NOT NULL,
        underlying_apr_30d REAL NOT NULL,
        best_bid_apr REAL NOT NULL,
        best_ask_apr REAL NOT NULL,
        best_long_size_base REAL,
        best_short_size_base REAL,
        time_to_maturity_seconds INTEGER NOT NULL,
        asset_mark_price REAL NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        market_id INTEGER NOT NULL,
        fair_apr REAL NOT NULL,
        edge_bps_long REAL NOT NULL,
        edge_bps_short REAL NOT NULL,
        sources_json TEXT NOT NULL,
        clipped_sources_json TEXT NOT NULL,
        candidate_json TEXT
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        client_order_id TEXT,
        market_id INTEGER NOT NULL,
        side TEXT NOT NULL,
        action TEXT NOT NULL,
        order_intent TEXT NOT NULL,
        size_base REAL NOT NULL,
        size_base18 TEXT NOT NULL,
        order_apr REAL NOT NULL,
        edge_bps REAL NOT NULL,
        net_edge_bps REAL NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'FILLED',
        external_order_id TEXT,
        market_acc TEXT,
        requested_size_base18 TEXT,
        placed_size_base18 TEXT,
        filled_size_base18 TEXT NOT NULL DEFAULT '0',
        remaining_size_base18 TEXT NOT NULL DEFAULT '0',
        applied_size_base18 TEXT NOT NULL DEFAULT '0',
        fill_apr REAL NOT NULL,
        block_timestamp INTEGER,
        last_reconciled_at INTEGER,
        notes TEXT,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        market_id INTEGER NOT NULL,
        token_id INTEGER NOT NULL DEFAULT 0,
        market_name TEXT NOT NULL,
        asset_symbol TEXT NOT NULL,
        is_isolated_only INTEGER NOT NULL DEFAULT 0,
        market_acc TEXT,
        side TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        entry_apr REAL NOT NULL,
        current_apr REAL NOT NULL,
        fixed_apr REAL NOT NULL,
        floating_apr REAL NOT NULL,
        size_base REAL NOT NULL,
        size_base18 TEXT NOT NULL,
        asset_mark_price REAL NOT NULL,
        notional_usd REAL NOT NULL,
        initial_margin_usd REAL NOT NULL,
        actual_leverage REAL NOT NULL,
        liquidation_apr REAL,
        liquidation_buffer_bps REAL,
        add_count INTEGER NOT NULL DEFAULT 0,
        realized_carry_pnl_usd REAL NOT NULL DEFAULT 0,
        realized_trading_pnl_usd REAL NOT NULL DEFAULT 0,
        unrealized_pnl_usd REAL NOT NULL DEFAULT 0,
        peak_pnl_usd REAL NOT NULL DEFAULT 0,
        peak_pnl_pct REAL NOT NULL DEFAULT 0,
        last_accrual_ts INTEGER NOT NULL,
        last_signal_edge_bps REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS kill_switch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS copy_target_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        target_address TEXT NOT NULL,
        positions_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS copy_trade_records (
        id TEXT PRIMARY KEY,
        recorded_at INTEGER NOT NULL,
        delta_action TEXT NOT NULL,
        target_market_id INTEGER NOT NULL,
        target_side TEXT NOT NULL,
        target_size_base REAL NOT NULL,
        our_client_order_id TEXT,
        our_size_base REAL NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        raw_json TEXT NOT NULL
      );
    `);

    this.ensureNullableFuturesPremium();
    this.ensureOrderLifecycleColumns();
    this.ensurePositionIsolatedFlag();
    this.ensurePositionTokenId();
    this.ensurePositionMarketAcc();
    this.ensurePositionPeakPnl();
  }

  private ensureNullableFuturesPremium(): void {
    const columns = this.db.prepare(`PRAGMA table_info(market_snapshots)`).all() as Array<{ name: string; notnull: number }>;
    const futuresPremium = columns.find((column) => column.name === "futures_premium");
    if (!futuresPremium || futuresPremium.notnull === 0) {
      return;
    }

    this.db.exec(`
      ALTER TABLE market_snapshots RENAME TO market_snapshots_old;
      CREATE TABLE market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        market_id INTEGER NOT NULL,
        market_name TEXT NOT NULL,
        asset_symbol TEXT NOT NULL,
        platform_name TEXT NOT NULL,
        mid_apr REAL NOT NULL,
        floating_apr REAL NOT NULL,
        futures_premium REAL,
        underlying_apr_7d REAL NOT NULL,
        underlying_apr_30d REAL NOT NULL,
        best_bid_apr REAL NOT NULL,
        best_ask_apr REAL NOT NULL,
        best_long_size_base REAL,
        best_short_size_base REAL,
        time_to_maturity_seconds INTEGER NOT NULL,
        asset_mark_price REAL NOT NULL,
        raw_json TEXT NOT NULL
      );
      INSERT INTO market_snapshots (
        id, recorded_at, market_id, market_name, asset_symbol, platform_name, mid_apr,
        floating_apr, futures_premium, underlying_apr_7d, underlying_apr_30d,
        best_bid_apr, best_ask_apr, best_long_size_base, best_short_size_base,
        time_to_maturity_seconds, asset_mark_price, raw_json
      )
      SELECT
        id, recorded_at, market_id, market_name, asset_symbol, platform_name, mid_apr,
        floating_apr, NULLIF(futures_premium, mid_apr), underlying_apr_7d, underlying_apr_30d,
        best_bid_apr, best_ask_apr, best_long_size_base, best_short_size_base,
        time_to_maturity_seconds, asset_mark_price, raw_json
      FROM market_snapshots_old;
      DROP TABLE market_snapshots_old;
    `);
  }

  private ensurePositionIsolatedFlag(): void {
    const columns = this.db.prepare(`PRAGMA table_info(positions)`).all() as Array<{ name: string }>;
    const hasColumn = columns.some((column) => column.name === "is_isolated_only");
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN is_isolated_only INTEGER NOT NULL DEFAULT 0;`);
    }
  }

  private ensurePositionMarketAcc(): void {
    const columns = this.db.prepare(`PRAGMA table_info(positions)`).all() as Array<{ name: string }>;
    const hasColumn = columns.some((column) => column.name === "market_acc");
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN market_acc TEXT;`);
    }
  }

  private ensurePositionTokenId(): void {
    const columns = this.db.prepare(`PRAGMA table_info(positions)`).all() as Array<{ name: string }>;
    const hasColumn = columns.some((column) => column.name === "token_id");
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN token_id INTEGER NOT NULL DEFAULT 0;`);
    }
  }

  private ensurePositionPeakPnl(): void {
    const columns = this.db.prepare(`PRAGMA table_info(positions)`).all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("peak_pnl_usd")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN peak_pnl_usd REAL NOT NULL DEFAULT 0;`);
    }
    if (!columnNames.has("peak_pnl_pct")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN peak_pnl_pct REAL NOT NULL DEFAULT 0;`);
    }
  }

  private ensureOrderLifecycleColumns(): void {
    const columns = this.db.prepare(`PRAGMA table_info(orders)`).all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const statements: string[] = [];

    if (!columnNames.has("client_order_id")) {
      statements.push(`ALTER TABLE orders ADD COLUMN client_order_id TEXT;`);
    }
    if (!columnNames.has("status")) {
      statements.push(`ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'FILLED';`);
    }
    if (!columnNames.has("market_acc")) {
      statements.push(`ALTER TABLE orders ADD COLUMN market_acc TEXT;`);
    }
    if (!columnNames.has("requested_size_base18")) {
      statements.push(`ALTER TABLE orders ADD COLUMN requested_size_base18 TEXT;`);
    }
    if (!columnNames.has("placed_size_base18")) {
      statements.push(`ALTER TABLE orders ADD COLUMN placed_size_base18 TEXT;`);
    }
    if (!columnNames.has("filled_size_base18")) {
      statements.push(`ALTER TABLE orders ADD COLUMN filled_size_base18 TEXT NOT NULL DEFAULT '0';`);
    }
    if (!columnNames.has("remaining_size_base18")) {
      statements.push(`ALTER TABLE orders ADD COLUMN remaining_size_base18 TEXT NOT NULL DEFAULT '0';`);
    }
    if (!columnNames.has("applied_size_base18")) {
      statements.push(`ALTER TABLE orders ADD COLUMN applied_size_base18 TEXT NOT NULL DEFAULT '0';`);
    }
    if (!columnNames.has("block_timestamp")) {
      statements.push(`ALTER TABLE orders ADD COLUMN block_timestamp INTEGER;`);
    }
    if (!columnNames.has("last_reconciled_at")) {
      statements.push(`ALTER TABLE orders ADD COLUMN last_reconciled_at INTEGER;`);
    }

    for (const statement of statements) {
      this.db.exec(statement);
    }

    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_order_id ON orders(client_order_id);`);
  }

  public saveSnapshot(snapshot: MarketSnapshot): void {
    this.db.prepare(`
      INSERT INTO market_snapshots (
        recorded_at, market_id, market_name, asset_symbol, platform_name, mid_apr,
        floating_apr, futures_premium, underlying_apr_7d, underlying_apr_30d,
        best_bid_apr, best_ask_apr, best_long_size_base, best_short_size_base,
        time_to_maturity_seconds, asset_mark_price, raw_json
      ) VALUES (
        @recordedAt, @marketId, @marketName, @assetSymbol, @platformName, @midApr,
        @floatingApr, @futuresPremium, @underlyingApr7d, @underlyingApr30d,
        @bestBidApr, @bestAskApr, @bestLongSizeBase, @bestShortSizeBase,
        @timeToMaturitySeconds, @assetMarkPrice, @rawJson
      )
    `).run({
      recordedAt: snapshot.recordedAt,
      marketId: snapshot.market.marketId,
      marketName: snapshot.market.name,
      assetSymbol: snapshot.market.assetSymbol,
      platformName: snapshot.market.platformName,
      midApr: snapshot.market.midApr,
      floatingApr: snapshot.market.floatingApr,
      futuresPremium: snapshot.indicators.futuresPremium ?? null,
      underlyingApr7d: snapshot.indicators.underlyingApr7d,
      underlyingApr30d: snapshot.indicators.underlyingApr30d,
      bestBidApr: snapshot.market.bestBid,
      bestAskApr: snapshot.market.bestAsk,
      bestLongSizeBase: snapshot.orderBook.bestLongSizeBase ?? null,
      bestShortSizeBase: snapshot.orderBook.bestShortSizeBase ?? null,
      timeToMaturitySeconds: snapshot.market.timeToMaturitySeconds,
      assetMarkPrice: snapshot.market.assetMarkPrice,
      rawJson: safeJsonStringify(snapshot),
    });
  }

  public saveSignal(signal: FairValueEstimate, candidate?: TradeCandidate): void {
    this.db.prepare(`
      INSERT INTO signals (
        recorded_at, market_id, fair_apr, edge_bps_long, edge_bps_short,
        sources_json, clipped_sources_json, candidate_json
      ) VALUES (
        @recordedAt, @marketId, @fairApr, @edgeBpsLong, @edgeBpsShort,
        @sourcesJson, @clippedSourcesJson, @candidateJson
      )
    `).run({
      recordedAt: Math.floor(Date.now() / 1000),
      marketId: signal.marketId,
      fairApr: signal.fairApr,
      edgeBpsLong: signal.edgeBpsLong,
      edgeBpsShort: signal.edgeBpsShort,
      sourcesJson: JSON.stringify(signal.sources),
      clippedSourcesJson: JSON.stringify(signal.clippedSources),
      candidateJson: candidate ? safeJsonStringify(candidate) : null,
    });
  }

  public saveOrder(record: ExecutionRecord): void {
    this.db.prepare(`
      INSERT INTO orders (
        recorded_at, client_order_id, market_id, side, action, order_intent, size_base, size_base18,
        order_apr, edge_bps, net_edge_bps, mode, status, external_order_id, market_acc,
        requested_size_base18, placed_size_base18, filled_size_base18, remaining_size_base18, applied_size_base18,
        fill_apr, block_timestamp, last_reconciled_at, notes, raw_json
      ) VALUES (
        @recordedAt, @clientOrderId, @marketId, @side, @action, @orderIntent, @sizeBase, @sizeBase18,
        @orderApr, @edgeBps, @netEdgeBps, @mode, @status, @externalOrderId, @marketAcc,
        @requestedSizeBase18, @placedSizeBase18, @filledSizeBase18, @remainingSizeBase18, @appliedSizeBase18,
        @fillApr, @blockTimestamp, @lastReconciledAt, @notes, @rawJson
      )
      ON CONFLICT(client_order_id) DO UPDATE SET
        recorded_at = excluded.recorded_at,
        status = excluded.status,
        external_order_id = excluded.external_order_id,
        market_acc = excluded.market_acc,
        requested_size_base18 = excluded.requested_size_base18,
        placed_size_base18 = excluded.placed_size_base18,
        filled_size_base18 = excluded.filled_size_base18,
        remaining_size_base18 = excluded.remaining_size_base18,
        applied_size_base18 = excluded.applied_size_base18,
        fill_apr = excluded.fill_apr,
        block_timestamp = excluded.block_timestamp,
        last_reconciled_at = excluded.last_reconciled_at,
        notes = excluded.notes,
        raw_json = excluded.raw_json
    `).run({
      recordedAt: record.executedAt,
      clientOrderId: record.clientOrderId,
      marketId: record.candidate.marketId,
      side: record.candidate.side,
      action: record.candidate.action,
      orderIntent: record.candidate.orderIntent,
      sizeBase: record.candidate.sizeBase,
      sizeBase18: record.candidate.sizeBase18.toString(),
      orderApr: record.candidate.orderApr,
      edgeBps: record.candidate.edgeBps,
      netEdgeBps: record.candidate.netEdgeBps,
      mode: record.mode,
      status: record.status,
      externalOrderId: record.externalOrderId ?? null,
      marketAcc: record.marketAcc ?? null,
      requestedSizeBase18: record.requestedSizeBase18,
      placedSizeBase18: record.placedSizeBase18 ?? null,
      filledSizeBase18: record.filledSizeBase18,
      remainingSizeBase18: record.remainingSizeBase18,
      appliedSizeBase18: record.appliedSizeBase18,
      fillApr: record.fillApr,
      blockTimestamp: record.blockTimestamp ?? null,
      lastReconciledAt: record.lastReconciledAt,
      notes: record.notes ?? null,
      rawJson: safeJsonStringify(record),
    });
  }

  public upsertPosition(position: OpenPosition): void {
    this.db.prepare(`
      INSERT INTO positions (
        id, market_id, token_id, market_name, asset_symbol, is_isolated_only, market_acc, side, status, opened_at, closed_at,
        entry_apr, current_apr, fixed_apr, floating_apr, size_base, size_base18,
        asset_mark_price, notional_usd, initial_margin_usd, actual_leverage,
        liquidation_apr, liquidation_buffer_bps, add_count,
        realized_carry_pnl_usd, realized_trading_pnl_usd, unrealized_pnl_usd,
        peak_pnl_usd, peak_pnl_pct,
        last_accrual_ts, last_signal_edge_bps
      ) VALUES (
        @id, @marketId, @tokenId, @marketName, @assetSymbol, @isIsolatedOnly, @marketAcc, @side, @status, @openedAt, @closedAt,
        @entryApr, @currentApr, @fixedApr, @floatingApr, @sizeBase, @sizeBase18,
        @assetMarkPrice, @notionalUsd, @initialMarginUsd, @actualLeverage,
        @liquidationApr, @liquidationBufferBps, @addCount,
        @realizedCarryPnlUsd, @realizedTradingPnlUsd, @unrealizedPnlUsd,
        @peakPnlUsd, @peakPnlPct,
        @lastAccrualTs, @lastSignalEdgeBps
      )
      ON CONFLICT(id) DO UPDATE SET
        token_id = excluded.token_id,
        is_isolated_only = excluded.is_isolated_only,
        market_acc = excluded.market_acc,
        status = excluded.status,
        closed_at = excluded.closed_at,
        current_apr = excluded.current_apr,
        floating_apr = excluded.floating_apr,
        asset_mark_price = excluded.asset_mark_price,
        liquidation_apr = excluded.liquidation_apr,
        liquidation_buffer_bps = excluded.liquidation_buffer_bps,
        add_count = excluded.add_count,
        realized_carry_pnl_usd = excluded.realized_carry_pnl_usd,
        realized_trading_pnl_usd = excluded.realized_trading_pnl_usd,
        unrealized_pnl_usd = excluded.unrealized_pnl_usd,
        peak_pnl_usd = excluded.peak_pnl_usd,
        peak_pnl_pct = excluded.peak_pnl_pct,
        last_accrual_ts = excluded.last_accrual_ts,
        last_signal_edge_bps = excluded.last_signal_edge_bps
    `).run({
      id: position.id,
      marketId: position.marketId,
      tokenId: position.tokenId,
      marketName: position.marketName,
      assetSymbol: position.assetSymbol,
      isIsolatedOnly: position.isIsolatedOnly ? 1 : 0,
      marketAcc: position.marketAcc ?? null,
      side: position.side,
      status: position.status,
      openedAt: position.openedAt,
      closedAt: position.closedAt ?? null,
      entryApr: position.entryApr,
      currentApr: position.currentApr,
      fixedApr: position.fixedApr,
      floatingApr: position.floatingApr,
      sizeBase: position.sizeBase,
      sizeBase18: position.sizeBase18,
      assetMarkPrice: position.assetMarkPrice,
      notionalUsd: position.notionalUsd,
      initialMarginUsd: position.initialMarginUsd,
      actualLeverage: position.actualLeverage,
      liquidationApr: position.liquidationApr ?? null,
      liquidationBufferBps: position.liquidationBufferBps ?? null,
      addCount: position.addCount,
      realizedCarryPnlUsd: position.realizedCarryPnlUsd,
      realizedTradingPnlUsd: position.realizedTradingPnlUsd,
      unrealizedPnlUsd: position.unrealizedPnlUsd,
      peakPnlUsd: position.peakPnlUsd,
      peakPnlPct: position.peakPnlPct,
      lastAccrualTs: position.lastAccrualTs,
      lastSignalEdgeBps: position.lastSignalEdgeBps,
    });
  }

  public getOpenPositions(): OpenPosition[] {
    const rows = this.db.prepare(`SELECT * FROM positions WHERE status = 'OPEN' ORDER BY opened_at ASC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToPosition(row));
  }

  public getAllPositions(): OpenPosition[] {
    const rows = this.db.prepare(`SELECT * FROM positions ORDER BY opened_at ASC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToPosition(row));
  }

  public getActiveOrders(): ExecutionRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM orders
      WHERE status IN ('SUBMITTED', 'OPEN', 'PARTIALLY_FILLED')
      ORDER BY recorded_at ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToOrder(row));
  }

  private rowToPosition(row: Record<string, unknown>): OpenPosition {
    return {
      id: String(row.id),
      marketId: Number(row.market_id),
      tokenId: Number(row.token_id ?? 0),
      marketName: String(row.market_name),
      assetSymbol: String(row.asset_symbol),
      isIsolatedOnly: Boolean(row.is_isolated_only),
      marketAcc: row.market_acc === null ? undefined : String(row.market_acc),
      side: String(row.side) as OpenPosition["side"],
      status: String(row.status) as OpenPosition["status"],
      openedAt: Number(row.opened_at),
      closedAt: row.closed_at === null ? undefined : Number(row.closed_at),
      entryApr: Number(row.entry_apr),
      currentApr: Number(row.current_apr),
      fixedApr: Number(row.fixed_apr),
      floatingApr: Number(row.floating_apr),
      sizeBase: Number(row.size_base),
      sizeBase18: String(row.size_base18),
      assetMarkPrice: Number(row.asset_mark_price),
      notionalUsd: Number(row.notional_usd),
      initialMarginUsd: Number(row.initial_margin_usd),
      actualLeverage: Number(row.actual_leverage),
      liquidationApr: row.liquidation_apr === null ? undefined : Number(row.liquidation_apr),
      liquidationBufferBps: row.liquidation_buffer_bps === null ? undefined : Number(row.liquidation_buffer_bps),
      addCount: Number(row.add_count),
      realizedCarryPnlUsd: Number(row.realized_carry_pnl_usd),
      realizedTradingPnlUsd: Number(row.realized_trading_pnl_usd),
      unrealizedPnlUsd: Number(row.unrealized_pnl_usd),
      peakPnlUsd: Number(row.peak_pnl_usd ?? 0),
      peakPnlPct: Number(row.peak_pnl_pct ?? 0),
      lastAccrualTs: Number(row.last_accrual_ts),
      lastSignalEdgeBps: Number(row.last_signal_edge_bps),
    };
  }

  private rowToOrder(row: Record<string, unknown>): ExecutionRecord {
    const raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>;
    const candidate = raw.candidate as Record<string, unknown>;
    return {
      clientOrderId: String(row.client_order_id),
      mode: String(row.mode) as ExecutionRecord["mode"],
      candidate: {
        ...candidate,
        sizeBase18: BigInt(String(candidate.sizeBase18)),
      } as TradeCandidate,
      status: String(row.status) as ExecutionRecord["status"],
      fillApr: Number(row.fill_apr),
      executedAt: Number(row.recorded_at),
      externalOrderId: row.external_order_id === null ? undefined : String(row.external_order_id),
      marketAcc: row.market_acc === null ? undefined : String(row.market_acc),
      requestedSizeBase18: String(row.requested_size_base18 ?? row.size_base18),
      placedSizeBase18: row.placed_size_base18 === null ? undefined : String(row.placed_size_base18),
      filledSizeBase18: String(row.filled_size_base18 ?? "0"),
      remainingSizeBase18: String(row.remaining_size_base18 ?? "0"),
      appliedSizeBase18: String(row.applied_size_base18 ?? "0"),
      blockTimestamp: row.block_timestamp === null ? undefined : Number(row.block_timestamp),
      lastReconciledAt: Number(row.last_reconciled_at ?? row.recorded_at),
      notes: row.notes === null ? undefined : String(row.notes),
    };
  }

  public setRuntimeValue(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO runtime_state (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, safeJsonStringify(value));
  }

  public getRuntimeValue<T>(key: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM runtime_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  public appendKillSwitchEvent(reason: string, payload: unknown): void {
    this.db.prepare(`INSERT INTO kill_switch_events (recorded_at, reason, raw_json) VALUES (?, ?, ?)`)
      .run(Math.floor(Date.now() / 1000), reason, JSON.stringify(payload));
  }

  public saveRiskState(state: RiskState): void {
    this.setRuntimeValue("risk_state", state);
  }

  public saveTargetSnapshot(targetAddress: string, positions: TargetPositionSnapshot[]): void {
    this.db.prepare(`
      INSERT INTO copy_target_snapshots (recorded_at, target_address, positions_json)
      VALUES (?, ?, ?)
    `).run(Math.floor(Date.now() / 1000), targetAddress, JSON.stringify(positions));
  }

  public saveCopyTradeRecord(record: CopyTradeRecord): void {
    this.db.prepare(`
      INSERT INTO copy_trade_records (
        id, recorded_at, delta_action, target_market_id, target_side,
        target_size_base, our_client_order_id, our_size_base, status, reason, raw_json
      ) VALUES (
        @id, @recordedAt, @deltaAction, @targetMarketId, @targetSide,
        @targetSizeBase, @ourClientOrderId, @ourSizeBase, @status, @reason, @rawJson
      )
    `).run({
      id: record.id,
      recordedAt: record.timestamp,
      deltaAction: record.deltaAction,
      targetMarketId: record.targetMarketId,
      targetSide: record.targetSide,
      targetSizeBase: record.targetSizeBase,
      ourClientOrderId: record.ourClientOrderId ?? null,
      ourSizeBase: record.ourSizeBase,
      status: record.status,
      reason: record.reason ?? null,
      rawJson: JSON.stringify(record),
    });
  }
}
