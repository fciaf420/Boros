import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type AgentRuntimeState =
  | "not_configured"
  | "ready"
  | "running"
  | "paused"
  | "stopped"
  | "error"
  | "kill_switched";

export interface AgentConfig {
  mode: "paper" | "live";
  acpEnabled: boolean;
  openWebResearch: boolean;
  strategyPack: "relative_value" | "settlement_sniper" | "negative_funding" | "cross_market";
  enabledStrategies: string[];
  marketAllowlist: string;
  marketBlocklist: string;
  maxPositions: number;
  maxInitialMarginPctPerMarket: number;
  maxTotalMarginPct: number;
  maxDailyDrawdownPct: number;
  leverageCap: number;
  marginUtilizationTargetPct: number;
  confidenceThreshold: number;
  allowEntries: boolean;
  allowAdds: boolean;
  allowReductions: boolean;
  allowCloses: boolean;
  allowCollateralOps: boolean;
  maxCollateralTransferUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopArmPct: number;
  trailingStopGivebackPct: number;
  pollingIntervalMs: number;
  closeOnly: boolean;
}

export interface AgentStatus {
  runtimeState: AgentRuntimeState;
  deployed: boolean;
  closeOnly: boolean;
  mode: "paper" | "live";
  acp: {
    installed: boolean;
    authenticated: boolean;
    message: string;
    authMode?: string;
    lastCheckedAt?: number;
    deviceAuth?: {
      active: boolean;
      verificationUri?: string;
      code?: string;
      startedAt?: number;
      message?: string;
    };
  };
  process: {
    pid?: number;
    startedAt?: number;
    lastHeartbeat?: number;
    lastExitCode?: number;
  };
  claudeFallback?: boolean;
  lastError?: string;
  updatedAt: number;
}

export interface AgentResearchNote {
  id: number;
  recordedAt: number;
  title: string;
  summary: string;
  metadataJson?: string;
}

export interface AgentRecommendation {
  id: number;
  recordedAt: number;
  marketId?: number;
  marketName?: string;
  strategyId: string;
  side?: string;
  action: string;
  confidence: number;
  status: string;
  thesis: string;
  evidenceJson?: string;
}

export interface AgentAction {
  id: number;
  recordedAt: number;
  type: string;
  marketId?: number;
  marketName?: string;
  status: string;
  summary: string;
  detailsJson?: string;
}

export interface AgentAuditEvent {
  id: number;
  recordedAt: number;
  level: "info" | "warn" | "error";
  category: string;
  message: string;
  detailsJson?: string;
}

export interface AgentWalletResearch {
  id: number;
  address: string;
  recordedAt: number;
  source: string;
  summary: string;
  payloadJson: string;
}

export interface AgentMemoryEntry {
  id: number;
  recordedAt: number;
  updatedAt: number;
  category: "market_insight" | "strategy_lesson" | "risk_observation" | "failure_pattern" | "general";
  key: string;
  content: string;
  confidence: number;
  expiresAt?: number;
}

export function defaultAgentConfig(): AgentConfig {
  return {
    mode: "paper",
    acpEnabled: true,
    openWebResearch: true,
    strategyPack: "relative_value",
    enabledStrategies: ["relative_value", "settlement_sniper"],
    marketAllowlist: "",
    marketBlocklist: "",
    maxPositions: 3,
    maxInitialMarginPctPerMarket: 0.1,
    maxTotalMarginPct: 0.35,
    maxDailyDrawdownPct: 0.03,
    leverageCap: 1.5,
    marginUtilizationTargetPct: 0.85,
    confidenceThreshold: 0.55,
    allowEntries: true,
    allowAdds: true,
    allowReductions: true,
    allowCloses: true,
    allowCollateralOps: true,
    maxCollateralTransferUsd: 500,
    takeProfitPct: 0.25,
    stopLossPct: 0.15,
    trailingStopArmPct: 0.15,
    trailingStopGivebackPct: 0.1,
    pollingIntervalMs: 60000,
    closeOnly: false,
  };
}

export function defaultAgentStatus(): AgentStatus {
  return {
    runtimeState: "not_configured",
    deployed: false,
    closeOnly: false,
    mode: "paper",
    acp: {
      installed: false,
      authenticated: false,
      message: "ACP unavailable",
      deviceAuth: {
        active: false,
      },
    },
    process: {},
    updatedAt: Date.now(),
  };
}

export class AgentStore {
  private readonly db: Database.Database;

  constructor(rootDir: string) {
    const dataDir = path.join(rootDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "boros_agent.sqlite");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deployed_at INTEGER NOT NULL,
        stopped_at INTEGER,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        pid INTEGER,
        config_json TEXT NOT NULL,
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_research (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        market_id INTEGER,
        market_name TEXT,
        strategy_id TEXT NOT NULL,
        side TEXT,
        action TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        thesis TEXT NOT NULL,
        evidence_json TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        market_id INTEGER,
        market_name TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS wallet_research_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL UNIQUE,
        recorded_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        category TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        expires_at INTEGER
      );
    `);
  }

  getConfig(): AgentConfig {
    const row = this.db.prepare("SELECT config_json FROM agent_config WHERE id = 1").get() as { config_json: string } | undefined;
    if (!row) {
      return defaultAgentConfig();
    }
    try {
      return { ...defaultAgentConfig(), ...(JSON.parse(row.config_json) as Partial<AgentConfig>) };
    } catch {
      return defaultAgentConfig();
    }
  }

  saveConfig(config: AgentConfig): void {
    this.db.prepare(`
      INSERT INTO agent_config (id, config_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(config), Date.now());
  }

  getStatus(): AgentStatus {
    const row = this.db.prepare("SELECT status_json FROM agent_status WHERE id = 1").get() as { status_json: string } | undefined;
    if (!row) {
      return defaultAgentStatus();
    }
    try {
      return { ...defaultAgentStatus(), ...(JSON.parse(row.status_json) as Partial<AgentStatus>) };
    } catch {
      return defaultAgentStatus();
    }
  }

  saveStatus(status: AgentStatus): void {
    const next = { ...status, updatedAt: Date.now() };
    this.db.prepare(`
      INSERT INTO agent_status (id, status_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status_json = excluded.status_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(next), next.updatedAt);
  }

  /** Wipe data from the previous session so the UI only shows current-session data. */
  clearSessionData(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_research").run();
      this.db.prepare("DELETE FROM agent_recommendations").run();
      this.db.prepare("DELETE FROM agent_actions").run();
      this.db.prepare("DELETE FROM agent_audit_events").run();
    });
    tx();
  }

  startSession(status: string, mode: string, pid: number | undefined, config: AgentConfig): number {
    this.clearSessionData();
    const result = this.db.prepare(`
      INSERT INTO agent_sessions (deployed_at, status, mode, pid, config_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(Date.now(), status, mode, pid ?? null, JSON.stringify(config));
    return Number(result.lastInsertRowid);
  }

  finishLatestSession(status: string, reason?: string): void {
    this.db.prepare(`
      UPDATE agent_sessions
      SET stopped_at = ?, status = ?, reason = ?
      WHERE id = (SELECT id FROM agent_sessions ORDER BY id DESC LIMIT 1)
    `).run(Date.now(), status, reason ?? null);
  }

  addResearch(title: string, summary: string, metadata?: unknown): void {
    this.db.prepare(`
      INSERT INTO agent_research (recorded_at, title, summary, metadata_json)
      VALUES (?, ?, ?, ?)
    `).run(Date.now(), title, summary, metadata ? JSON.stringify(metadata) : null);
  }

  replaceRecommendations(recommendations: Omit<AgentRecommendation, "id">[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_recommendations").run();
      const insert = this.db.prepare(`
        INSERT INTO agent_recommendations (
          recorded_at, market_id, market_name, strategy_id, side, action, confidence, status, thesis, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of recommendations) {
        insert.run(
          item.recordedAt,
          item.marketId ?? null,
          item.marketName ?? null,
          item.strategyId,
          item.side ?? null,
          item.action,
          item.confidence,
          item.status,
          item.thesis,
          item.evidenceJson ?? null,
        );
      }
    });
    tx();
  }

  recordAction(type: string, status: string, summary: string, details?: unknown, marketId?: number, marketName?: string): void {
    this.db.prepare(`
      INSERT INTO agent_actions (recorded_at, type, market_id, market_name, status, summary, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(Date.now(), type, marketId ?? null, marketName ?? null, status, summary, details ? JSON.stringify(details) : null);
  }

  recordAudit(level: AgentAuditEvent["level"], category: string, message: string, details?: unknown): void {
    this.db.prepare(`
      INSERT INTO agent_audit_events (recorded_at, level, category, message, details_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(Date.now(), level, category, message, details ? JSON.stringify(details) : null);
  }

  getResearch(limit = 20): AgentResearchNote[] {
    return this.db.prepare(`
      SELECT id, recorded_at as recordedAt, title, summary, metadata_json as metadataJson
      FROM agent_research ORDER BY recorded_at DESC LIMIT ?
    `).all(limit) as AgentResearchNote[];
  }

  getRecommendations(limit = 20): AgentRecommendation[] {
    return this.db.prepare(`
      SELECT id, recorded_at as recordedAt, market_id as marketId, market_name as marketName, strategy_id as strategyId,
        side, action, confidence, status, thesis, evidence_json as evidenceJson
      FROM agent_recommendations ORDER BY confidence DESC, recorded_at DESC LIMIT ?
    `).all(limit) as AgentRecommendation[];
  }

  getActions(limit = 50): AgentAction[] {
    return this.db.prepare(`
      SELECT id, recorded_at as recordedAt, type, market_id as marketId, market_name as marketName, status, summary, details_json as detailsJson
      FROM agent_actions ORDER BY recorded_at DESC LIMIT ?
    `).all(limit) as AgentAction[];
  }

  getAudit(limit = 100): AgentAuditEvent[] {
    return this.db.prepare(`
      SELECT id, recorded_at as recordedAt, level, category, message, details_json as detailsJson
      FROM agent_audit_events ORDER BY recorded_at DESC LIMIT ?
    `).all(limit) as AgentAuditEvent[];
  }

  recordWalletResearch(address: string, source: string, summary: string, payload: unknown): void {
    this.db.prepare(`
      INSERT INTO wallet_research_cache (address, recorded_at, source, summary, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        recorded_at = excluded.recorded_at,
        source = excluded.source,
        summary = excluded.summary,
        payload_json = excluded.payload_json
    `).run(address.toLowerCase(), Date.now(), source, summary, JSON.stringify(payload));
  }

  getWalletResearch(limit = 20): AgentWalletResearch[] {
    return this.db.prepare(`
      SELECT id, address, recorded_at as recordedAt, source, summary, payload_json as payloadJson
      FROM wallet_research_cache
      ORDER BY recorded_at DESC
      LIMIT ?
    `).all(limit) as AgentWalletResearch[];
  }

  upsertMemory(category: AgentMemoryEntry["category"], key: string, content: string, confidence = 0.5, expiresAt?: number): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_memory (recorded_at, updated_at, category, key, content, confidence, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        updated_at = excluded.updated_at,
        category = excluded.category,
        content = excluded.content,
        confidence = excluded.confidence,
        expires_at = excluded.expires_at
    `).run(now, now, category, key, content, confidence, expiresAt ?? null);
  }

  getMemories(limit = 50): AgentMemoryEntry[] {
    const now = Date.now();
    return this.db.prepare(`
      SELECT id, recorded_at as recordedAt, updated_at as updatedAt, category, key, content, confidence, expires_at as expiresAt
      FROM agent_memory
      WHERE expires_at IS NULL OR expires_at > ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(now, limit) as AgentMemoryEntry[];
  }

  getMemoriesByCategory(category: string, limit = 20): AgentMemoryEntry[] {
    const now = Date.now();
    return this.db.prepare(`
      SELECT id, recorded_at as recordedAt, updated_at as updatedAt, category, key, content, confidence, expires_at as expiresAt
      FROM agent_memory
      WHERE category = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `).all(category, now, limit) as AgentMemoryEntry[];
  }

  deleteMemory(key: string): void {
    this.db.prepare("DELETE FROM agent_memory WHERE key = ?").run(key);
  }

  pruneExpiredMemories(): number {
    const result = this.db.prepare("DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now());
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
