import type { Express } from "express";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import Database from "better-sqlite3";
import {
  AgentStore,
  defaultAgentConfig,
  type AgentConfig,
  type AgentStatus,
  type AgentRuntimeState,
  type AgentWalletResearch,
  type AgentMemoryEntry,
} from "./agentStore.js";
import {
  AgentSecretStore,
  type AgentSecretsInput,
  type AgentSecretsStatus,
} from "./secretStore.js";

interface CreateAgentControllerOptions {
  app: Express;
  rootDir: string;
  traderSqlitePath: string;
}

interface LeaderboardSnapshot {
  updatedAt: number;
  entries: Array<{
    address: string;
    return30d: number | null;
    equity: number;
    positionCount: number;
    totalNotional: number;
    lastActive: number;
  }>;
}

interface SqliteSignalRow {
  recorded_at: number;
  market_id: number;
  fair_apr: number;
  edge_bps_long: number;
  edge_bps_short: number;
  candidate_json: string | null;
}

interface SqliteSnapshotRow {
  recorded_at: number;
  market_id: number;
  market_name: string;
  asset_symbol: string;
  platform_name: string;
  mid_apr: number;
  floating_apr: number;
  futures_premium: number | null;
  underlying_apr_7d: number;
  underlying_apr_30d: number;
  best_bid_apr: number;
  best_ask_apr: number;
  best_long_size_base: number | null;
  best_short_size_base: number | null;
  time_to_maturity_seconds: number;
  asset_mark_price: number;
  raw_json?: string | null;
}

interface SqliteOrderRow {
  id: number;
  recorded_at: number;
  market_id: number;
  side: string;
  action: string;
  status: string;
  notes: string | null;
  net_edge_bps: number;
}

interface SqlitePositionRow {
  market_id: number;
  market_name: string;
  side: string;
  status: string;
  entry_apr?: number;
  current_apr?: number;
  floating_apr?: number;
  size_base?: number;
  notional_usd?: number;
  initial_margin_usd?: number;
  unrealized_pnl_usd?: number;
  realized_carry_pnl_usd?: number;
  realized_trading_pnl_usd?: number;
  liquidation_buffer_bps?: number;
  add_count?: number;
  last_signal_edge_bps?: number;
}

interface AgentDecisionRecommendation {
  marketId?: number;
  marketName?: string;
  side?: "LONG" | "SHORT";
  action: "ENTER" | "EXIT" | "ADD" | "REDUCE" | "HOLD" | "WATCH";
  confidence: number;
  thesis: string;
}

interface AgentDecision {
  summary: string;
  rationale: string;
  strategyPack: AgentConfig["strategyPack"];
  marketAllowlist: number[];
  closeOnly: boolean;
  confidenceThreshold?: number;
  recommendations: AgentDecisionRecommendation[];
  memoryUpdates?: Array<{
    category: "market_insight" | "strategy_lesson" | "risk_observation" | "failure_pattern" | "general";
    key: string;
    content: string;
    confidence?: number;
    ttlHours?: number;
  }>;
  memoryDeletes?: string[];
  parameterAdjustments?: {
    confidenceThreshold?: number;
    maxPositions?: number;
    maxDailyDrawdownPct?: number;
    pollingIntervalMs?: number;
    leverageCap?: number;
    marginUtilizationTargetPct?: number;
    maxInitialMarginPctPerMarket?: number;
    maxTotalMarginPct?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    trailingStopArmPct?: number;
    trailingStopGivebackPct?: number;
  };
  collateralOps?: Array<{
    action: "DEPOSIT_ISOLATED" | "WITHDRAW_ISOLATED" | "SWEEP_ALL_ISOLATED";
    marketId?: number;
    amountUsd?: number;
    reason: string;
  }>;
}

function parseCsvToIds(raw: string): number[] {
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function toEnvString(config: AgentConfig): Record<string, string> {
  const strategyDefaults: Record<string, string> =
    config.strategyPack === "settlement_sniper"
      ? {
          BOROS_MIN_EDGE_BPS: "120",
          BOROS_AGGRESSIVE_ENTRY_BPS: "180",
          BOROS_MIN_DAYS_TO_MATURITY: "1",
          BOROS_MIN_ENTRY_LIQ_BUFFER_BPS: "250",
        }
      : config.strategyPack === "negative_funding"
        ? {
            BOROS_MIN_EDGE_BPS: "120",
            BOROS_AGGRESSIVE_ENTRY_BPS: "220",
            BOROS_ALLOW_ISOLATED_MARKETS: "true",
          }
        : config.strategyPack === "cross_market"
          ? {
              BOROS_MIN_EDGE_BPS: "170",
              BOROS_AGGRESSIVE_ENTRY_BPS: "280",
              BOROS_MIN_LIQUIDITY_COVERAGE: "2.5",
            }
          : {
              BOROS_MIN_EDGE_BPS: "150",
              BOROS_AGGRESSIVE_ENTRY_BPS: "300",
            };

  const allowlist = parseCsvToIds(config.marketAllowlist).join(",");
  const mode = config.mode;
  const maxConcurrent = config.closeOnly ? 0 : config.maxPositions;

  return {
    ...strategyDefaults,
    BOROS_MODE: mode,
    BOROS_COPY_TRADE_ENABLED: "false",
    BOROS_DRY_RUN: mode === "paper" ? "true" : "false",
    BOROS_ALLOWED_MARKET_IDS: allowlist,
    ...(config.marketBlocklist ? { BOROS_BLOCKLIST_MARKET_IDS: parseCsvToIds(config.marketBlocklist).join(",") } : {}),
    BOROS_MAX_CONCURRENT_MARKETS: String(maxConcurrent),
    BOROS_MAX_INITIAL_MARGIN_PCT_PER_MARKET: String(config.maxInitialMarginPctPerMarket),
    BOROS_MAX_TOTAL_INITIAL_MARGIN_PCT: String(config.maxTotalMarginPct),
    BOROS_MAX_DAILY_DRAWDOWN_PCT: String(config.maxDailyDrawdownPct),
    BOROS_MAX_EFFECTIVE_LEVERAGE: String(config.leverageCap),
    BOROS_MARGIN_UTILIZATION_TARGET_PCT: String(config.marginUtilizationTargetPct),
    BOROS_POLLING_INTERVAL_MS: String(config.pollingIntervalMs),
    BOROS_TAKE_PROFIT_PCT: String(config.takeProfitPct),
    BOROS_STOP_LOSS_PCT: String(config.stopLossPct),
    BOROS_TRAILING_STOP_ARM_PCT: String(config.trailingStopArmPct),
    BOROS_TRAILING_STOP_GIVEBACK_PCT: String(config.trailingStopGivebackPct),
    BOROS_AGENT_ALLOW_ENTRIES: config.allowEntries ? "true" : "false",
    BOROS_AGENT_ALLOW_ADDS: config.allowAdds ? "true" : "false",
    BOROS_AGENT_ALLOW_REDUCTIONS: config.allowReductions ? "true" : "false",
    BOROS_AGENT_ALLOW_CLOSES: config.allowCloses ? "true" : "false",
    BOROS_AGENT_ALLOW_COLLATERAL_OPS: config.allowCollateralOps ? "true" : "false",
    BOROS_AGENT_CONFIDENCE_THRESHOLD: String(config.confidenceThreshold),
    BOROS_MAX_COLLATERAL_TRANSFER_USD: String(config.maxCollateralTransferUsd),
  };
}

function commandExists(command: string): boolean {
  const probe = process.platform === "win32"
    ? spawnSync("cmd", ["/c", command, "--help"], { encoding: "utf8" })
    : spawnSync(command, ["--help"], { encoding: "utf8" });
  return probe.status === 0;
}

function runCommandCapture(command: string, args: string[]): { ok: boolean; output: string } {
  const probe = process.platform === "win32"
    ? spawnSync("cmd", ["/c", command, ...args], { encoding: "utf8" })
    : spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: probe.status === 0,
    output: `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim(),
  };
}

function normalizeOutput(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "").trim();
}

function isValidAddress(value: string | undefined): boolean {
  return Boolean(value && /^0x[a-fA-F0-9]{40}$/.test(value.trim()));
}

function isValidPrivateKey(value: string | undefined): boolean {
  return Boolean(value && /^0x[a-fA-F0-9]{64}$/.test(value.trim()));
}

interface DeviceAuthState {
  active: boolean;
  verificationUri?: string;
  code?: string;
  startedAt?: number;
  message?: string;
}

function truncateForPrompt(value: string, maxLength: number): string {
  const normalized = value.replace(/\r/g, "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}\n\n[truncated]`;
}

interface FailureAnalysis {
  categories: Record<string, { count: number; recentExamples: string[] }>;
  totalFailures: number;
  topFailureMode: string | null;
  countermeasures: string[];
}

function analyzeIntentFailures(intents: Array<{ status: string; status_reason: string | null; action: string }>): FailureAnalysis {
  const failures = intents.filter((i) => i.status === "REJECTED" || i.status === "EXPIRED");
  const categories: Record<string, { count: number; recentExamples: string[] }> = {};

  for (const f of failures) {
    const reason = f.status_reason ?? "unknown";
    let cat = "OTHER";
    if (/liquidity|book|size/i.test(reason)) cat = "LIQUIDITY_INSUFFICIENT";
    else if (/margin|budget/i.test(reason)) cat = "MARGIN_EXHAUSTED";
    else if (/kill.?switch/i.test(reason)) cat = "KILL_SWITCH_ACTIVE";
    else if (/permission|denied|disabled/i.test(reason)) cat = "PERMISSION_DENIED";
    else if (/confidence|threshold/i.test(reason)) cat = "CONFIDENCE_TOO_LOW";
    else if (/unavailable|snapshot/i.test(reason)) cat = "MARKET_UNAVAILABLE";
    else if (/position|exists|no open/i.test(reason)) cat = "POSITION_CONFLICT";
    else if (/expired|superseded/i.test(reason)) cat = "EXPIRED";
    else if (/execution|failed|order/i.test(reason)) cat = "EXECUTION_FAILED";

    if (!categories[cat]) categories[cat] = { count: 0, recentExamples: [] };
    categories[cat].count++;
    if (categories[cat].recentExamples.length < 2) {
      categories[cat].recentExamples.push(`${f.action}: ${reason}`);
    }
  }

  const topFailureMode = Object.entries(categories).sort((a, b) => b[1].count - a[1].count)[0]?.[0] ?? null;

  const countermeasures: string[] = [];
  if (categories["LIQUIDITY_INSUFFICIENT"]) countermeasures.push("Reduce position sizes or target more liquid markets.");
  if (categories["MARGIN_EXHAUSTED"]) countermeasures.push("Close existing positions or reduce maxPositions before entering new trades.");
  if (categories["CONFIDENCE_TOO_LOW"]) countermeasures.push("Wait for stronger signals or consider lowering confidenceThreshold via parameterAdjustments.");
  if (categories["PERMISSION_DENIED"]) countermeasures.push("Some actions are disabled by user config. Focus on permitted action types.");
  if (categories["POSITION_CONFLICT"]) countermeasures.push("Check open positions before recommending ENTER/EXIT to avoid conflicts.");
  if (categories["EXPIRED"]) countermeasures.push("Decisions are being superseded too quickly. Increase conviction or reduce polling interval.");

  return { categories, totalFailures: failures.length, topFailureMode, countermeasures };
}

class AgentRuntimeController {
  private readonly store: AgentStore;
  private readonly secretStore: AgentSecretStore;
  private readonly rootDir: string;
  private readonly traderSqlitePath: string;
  private readonly leaderboardCachePath: string;
  private readonly agentDecisionSchemaPath: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private acpLoginChild: ChildProcessWithoutNullStreams | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private readonly recentLogs: Array<{ ts: number; line: string }> = [];
  private lastSyncedOrderId = 0;
  private status: AgentStatus;
  private deviceAuthState: DeviceAuthState = { active: false };
  private decisionInFlight = false;
  private lastDecisionAt = 0;
  private consecutiveDecisionFailures = 0;
  private killSwitchOverridden = false;

  constructor(rootDir: string, traderSqlitePath: string) {
    this.rootDir = rootDir;
    this.traderSqlitePath = traderSqlitePath;
    this.leaderboardCachePath = path.join(rootDir, "data", "leaderboard.json");
    this.agentDecisionSchemaPath = path.join(rootDir, "data", "agent_decision_schema.json");
    this.store = new AgentStore(rootDir);
    this.secretStore = new AgentSecretStore(rootDir);
    this.ensureDecisionSchema();
    this.status = this.withAcpStatus(this.store.getStatus());
    this.store.saveStatus(this.status);
    this.restoreIfNeeded();
  }

  private readAcpStatus(): AgentStatus["acp"] {
    const installed = commandExists("codex-acp") && commandExists("codex");
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        message: "codex-acp or codex CLI not found in PATH",
        lastCheckedAt: Date.now(),
        deviceAuth: this.deviceAuthState,
      };
    }

    const statusProbe = normalizeOutput(runCommandCapture("codex", ["login", "status"]).output);
    const authenticated = /Logged in/i.test(statusProbe) && !/Not logged in/i.test(statusProbe);

    let authMode: string | undefined;
    try {
      const authPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "auth.json");
      if (fs.existsSync(authPath)) {
        const parsed = JSON.parse(fs.readFileSync(authPath, "utf-8")) as { auth_mode?: string };
        authMode = parsed.auth_mode;
      }
    } catch {
      authMode = undefined;
    }

    return {
      installed: true,
      authenticated,
      authMode,
      message: authenticated ? statusProbe || "Logged in to Codex" : statusProbe || "Codex login required",
      lastCheckedAt: Date.now(),
      deviceAuth: this.deviceAuthState,
    };
  }

  private withAcpStatus(status: AgentStatus): AgentStatus {
    return {
      ...status,
      acp: this.readAcpStatus(),
      updatedAt: Date.now(),
    };
  }

  private setStatus(update: Partial<AgentStatus>): void {
    this.status = this.withAcpStatus({
      ...this.status,
      ...update,
      process: { ...this.status.process, ...(update.process ?? {}) },
      updatedAt: Date.now(),
    });
    this.store.saveStatus(this.status);
  }

  private pushLog(line: string): void {
    const next = { ts: Date.now(), line };
    this.recentLogs.unshift(next);
    if (this.recentLogs.length > 200) {
      this.recentLogs.length = 200;
    }
  }

  private recordAudit(level: "info" | "warn" | "error", category: string, message: string, details?: unknown): void {
    this.store.recordAudit(level, category, message, details);
  }

  private ensureDecisionSchema(): void {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["summary", "rationale", "strategyPack", "marketAllowlist", "closeOnly", "confidenceThreshold", "recommendations"],
      properties: {
        summary: { type: "string" },
        rationale: { type: "string" },
        strategyPack: {
          type: "string",
          enum: ["relative_value", "settlement_sniper", "negative_funding", "cross_market"],
        },
        marketAllowlist: {
          type: "array",
          items: { type: "integer", minimum: 1 },
        },
        closeOnly: { type: "boolean" },
        confidenceThreshold: {
          anyOf: [
            { type: "number", minimum: 0, maximum: 1 },
            { type: "null" },
          ],
        },
        recommendations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["marketId", "marketName", "side", "action", "confidence", "thesis"],
            properties: {
              marketId: {
                anyOf: [
                  { type: "integer", minimum: 1 },
                  { type: "null" },
                ],
              },
              marketName: {
                anyOf: [
                  { type: "string" },
                  { type: "null" },
                ],
              },
              side: {
                anyOf: [
                  { type: "string", enum: ["LONG", "SHORT"] },
                  { type: "null" },
                ],
              },
              action: { type: "string", enum: ["ENTER", "EXIT", "ADD", "REDUCE", "HOLD", "WATCH"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              thesis: { type: "string" },
            },
          },
        },
      },
    };
    fs.writeFileSync(this.agentDecisionSchemaPath, JSON.stringify(schema, null, 2), "utf-8");
  }

  private loadBorosSkillContext(): string {
    const archivePath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".agents", "skills", "skill-creator", "boros-trading-agent.skill");

    let skill = "";
    let strategyRef = "";
    let protocolRef = "";

    if (fs.existsSync(archivePath)) {
      const readFromArchive = (entry: string): string => {
        const probe = spawnSync("tar", ["-xOf", archivePath, entry], { encoding: "utf8" });
        return probe.status === 0 ? (probe.stdout ?? "") : "";
      };
      skill = readFromArchive("boros-trading-agent/SKILL.md");
      strategyRef = readFromArchive("boros-trading-agent/references/trading-strategy.md");
      protocolRef = readFromArchive("boros-trading-agent/references/boros-protocol.md");
    } else {
      const skillDir = path.join(this.rootDir, "skills", "boros-trading-agent");
      const readFile = (filePath: string): string => {
        try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
      };
      skill = readFile(path.join(skillDir, "SKILL.md"));
      strategyRef = readFile(path.join(skillDir, "references", "trading-strategy.md"));
      protocolRef = readFile(path.join(skillDir, "references", "boros-protocol.md"));
    }

    if (!skill && !strategyRef && !protocolRef) {
      return "Boros skill context not found; use project context only.";
    }

    return [
      "Boros Skill Playbook:",
      truncateForPrompt(skill, 5000),
      "",
      "Boros Strategy Reference:",
      truncateForPrompt(strategyRef, 3500),
      "",
      "Boros Protocol Reference:",
      truncateForPrompt(protocolRef, 2500),
    ].join("\n");
  }

  private currentSecretsStatus(): AgentSecretsStatus {
    return this.secretStore.getStatus();
  }

  private validateDeploy(config: AgentConfig): string[] {
    const errors: string[] = [];
    const acp = this.readAcpStatus();
    const secrets = this.currentSecretsStatus();

    if (config.acpEnabled) {
      if (!acp.installed) {
        errors.push("ACP runtime is not installed. Install codex-acp and codex on this machine.");
      } else if (!acp.authenticated) {
        errors.push("ACP is not authenticated. Complete Codex login before deploying the agent.");
      }
    }

    if (config.mode === "live") {
      const resolvedSecrets = this.secretStore.resolve();
      if (!secrets.configured) {
        errors.push(`Live deploy requires Boros signing credentials: ${secrets.missing.join(", ")}.`);
      }
      if (!isValidAddress(resolvedSecrets.rootAddress)) {
        errors.push("Stored Boros root address is invalid.");
      }
      if (!isValidPrivateKey(resolvedSecrets.privateKey)) {
        errors.push("Stored Boros private key is invalid.");
      }
      if (!resolvedSecrets.rpcUrl) {
        errors.push("Stored Boros RPC URL is missing.");
      }
      if (!resolvedSecrets.accountId || !/^\d+$/.test(resolvedSecrets.accountId)) {
        errors.push("Stored Boros account id must be an integer.");
      }
    }

    if (!config.closeOnly && config.maxPositions <= 0) {
      errors.push("Max positions must be greater than 0 unless close-only mode is enabled.");
    }
    if (config.maxInitialMarginPctPerMarket <= 0 || config.maxTotalMarginPct <= 0) {
      errors.push("Per-market and total margin limits must be greater than 0.");
    }

    return [...new Set(errors)];
  }

  private updateAcpDeviceAuth(update: Partial<DeviceAuthState>): void {
    this.deviceAuthState = { ...this.deviceAuthState, ...update };
    this.setStatus({});
  }

  private refreshReadinessState(): void {
    if (this.child || this.status.runtimeState === "paused" || this.status.runtimeState === "running") {
      return;
    }
    const config = this.store.getConfig();
    const validationErrors = this.validateDeploy(config);
    this.setStatus({
      mode: config.mode,
      closeOnly: config.closeOnly,
      runtimeState: validationErrors.length === 0 ? "ready" : "error",
      lastError: validationErrors.length === 0 ? undefined : validationErrors.join(" "),
    });
  }

  async startAcpDeviceAuth(): Promise<AgentStatus["acp"]> {
    const current = this.readAcpStatus();
    if (current.authenticated) {
      return current;
    }
    if (!current.installed) {
      throw new Error("codex-acp or codex CLI is not installed on this machine.");
    }
    if (this.acpLoginChild) {
      return this.readAcpStatus();
    }

    const child = process.platform === "win32"
      ? spawn("cmd", ["/c", "codex", "login", "--device-auth"], {
          cwd: this.rootDir,
          env: process.env,
          stdio: "pipe",
        })
      : spawn("codex", ["login", "--device-auth"], {
          cwd: this.rootDir,
          env: process.env,
          stdio: "pipe",
        });

    this.acpLoginChild = child;
    this.updateAcpDeviceAuth({
      active: true,
      startedAt: Date.now(),
      message: "Waiting for Codex device authorization to complete...",
    });
    this.recordAudit("info", "acp", "Started ACP device authorization flow");

    const handleChunk = (buffer: Buffer): void => {
      const cleaned = normalizeOutput(String(buffer));
      if (!cleaned) return;
      this.pushLog(`[acp] ${cleaned}`);
      const verificationUri = cleaned.match(/https:\/\/auth\.openai\.com\/codex\/device/i)?.[0];
      const code = cleaned.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0];
      if (verificationUri || code) {
        this.updateAcpDeviceAuth({
          verificationUri: verificationUri ?? this.deviceAuthState.verificationUri,
          code: code ?? this.deviceAuthState.code,
          message: "Open the verification link and enter the one-time code to authenticate Codex.",
        });
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);
    child.on("exit", () => {
      this.acpLoginChild = null;
      const refreshed = this.readAcpStatus();
      this.updateAcpDeviceAuth({
        active: false,
        verificationUri: undefined,
        code: undefined,
        message: refreshed.authenticated
          ? "ACP authentication complete."
          : "ACP device authorization finished without an authenticated session.",
      });
      this.recordAudit(
        refreshed.authenticated ? "info" : "warn",
        "acp",
        refreshed.authenticated ? "ACP device authorization completed" : "ACP device authorization ended without login",
      );
      this.refreshReadinessState();
    });

    return this.readAcpStatus();
  }

  saveSecrets(input: AgentSecretsInput): AgentSecretsStatus {
    const status = this.secretStore.save(input);
    this.recordAudit("info", "secrets", "Updated locally stored Boros signing credentials", {
      source: status.source,
      configured: status.configured,
      missing: status.missing,
    });
    this.refreshReadinessState();
    return status;
  }

  clearSecrets(): AgentSecretsStatus {
    const status = this.secretStore.clear();
    this.recordAudit("warn", "secrets", "Cleared locally stored Boros signing credentials");
    this.refreshReadinessState();
    return status;
  }

  private runSync(): void {
    try {
      const config = this.store.getConfig();
      if (!config.acpEnabled) {
        this.syncRecommendations();
      }
      this.syncOrdersToActions();
      this.syncResearch();
      this.checkEngineHealth(config);
      void this.runAcpDecisionIfNeeded();
    } catch (error) {
      this.recordAudit("error", "sync", "Agent sync failed", { error: String(error) });
      this.setStatus({ runtimeState: "error", lastError: String(error) });
    }
  }

  private checkEngineHealth(config: AgentConfig): void {
    const status = this.store.getStatus();
    if (status.runtimeState !== "running") return;

    // 1. Detect stalled engine — no heartbeat for 5× polling interval
    const heartbeat = status.process?.lastHeartbeat;
    const stallThresholdMs = Math.max(config.pollingIntervalMs * 5, 300_000);
    if (heartbeat && (Date.now() - heartbeat > stallThresholdMs)) {
      this.recordAudit("warn", "health", `Engine stalled: no heartbeat for ${Math.round((Date.now() - heartbeat) / 1000)}s — restarting`);
      this.pushLog(`[health] engine stalled — restarting`);
      void this.stop("Engine stalled — auto-restart").then(() => this.start(config));
      return;
    }

    // 2. Detect kill switch from engine's stored risk_state
    const db = this.openTraderDb();
    if (!db) return;
    try {
      const row = db.prepare("SELECT value FROM runtime_state WHERE key = 'risk_state'").get() as { value: string } | undefined;
      if (!row) return;
      const riskState = JSON.parse(row.value) as { killSwitchActive?: boolean; failureStreak?: number; dailyPnlPct?: number };

      if (riskState.killSwitchActive && !config.closeOnly && !this.killSwitchOverridden) {
        this.pushLog(`[health] kill switch detected — activating close-only mode`);
        this.recordAudit("warn", "health", "Kill switch triggered by engine — auto-activating close-only", {
          failureStreak: riskState.failureStreak,
          dailyPnlPct: riskState.dailyPnlPct,
        });
        const nextConfig = { ...config, closeOnly: true };
        this.store.saveConfig(nextConfig);
        this.setStatus({ closeOnly: true, lastError: "Kill switch active — close-only mode" });
        void this.start(nextConfig);
      }
    } catch { /* ignore parse errors */ } finally {
      db.close();
    }
  }

  private startSyncLoop(): void {
    this.stopSyncLoop();
    this.runSync();
    this.syncTimer = setInterval(() => this.runSync(), 30_000);
  }

  private stopSyncLoop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private openTraderDb(): Database.Database | null {
    if (!fs.existsSync(this.traderSqlitePath)) {
      return null;
    }
    try {
      return new Database(this.traderSqlitePath, { readonly: true });
    } catch {
      return null;
    }
  }

  private withWritableTraderDb<T>(fn: (db: Database.Database) => T): T | null {
    fs.mkdirSync(path.dirname(this.traderSqlitePath), { recursive: true });
    const db = new Database(this.traderSqlitePath);
    try {
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_execution_intents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recorded_at INTEGER NOT NULL,
          market_id INTEGER NOT NULL,
          market_name TEXT,
          side TEXT,
          action TEXT NOT NULL,
          confidence REAL NOT NULL,
          thesis TEXT NOT NULL,
          source TEXT NOT NULL,
          expires_at INTEGER,
          status TEXT NOT NULL DEFAULT 'PENDING',
          status_reason TEXT,
          applied_at INTEGER,
          raw_json TEXT NOT NULL
        );
      `);
      return fn(db);
    } finally {
      db.close();
    }
  }

  private syncRecommendations(): void {
    const db = this.openTraderDb();
    if (!db) {
      return;
    }
    try {
      const rows = db.prepare(`
        SELECT recorded_at, market_id, fair_apr, edge_bps_long, edge_bps_short, candidate_json
        FROM signals
        ORDER BY recorded_at DESC
        LIMIT 100
      `).all() as SqliteSignalRow[];
      const latestByMarket = new Map<number, SqliteSignalRow>();
      for (const row of rows) {
        if (!latestByMarket.has(row.market_id)) {
          latestByMarket.set(row.market_id, row);
        }
      }

      const config = this.store.getConfig();
      const recommendations = [...latestByMarket.values()]
        .map((row) => {
          const candidate = row.candidate_json ? safeParseJson(row.candidate_json) : null;
          const side = (candidate?.side as string | undefined) ?? (Math.abs(row.edge_bps_long) >= Math.abs(row.edge_bps_short) ? "LONG" : "SHORT");
          const marketName = (candidate?.marketName as string | undefined) ?? `Market ${row.market_id}`;
          const edge = side === "LONG" ? row.edge_bps_long : row.edge_bps_short;
          const confidence = Math.max(0, Math.min(1, Math.abs(edge) / 500));
          if (confidence < config.confidenceThreshold) {
            return null;
          }
          return {
            recordedAt: row.recorded_at * 1000,
            marketId: row.market_id,
            marketName,
            strategyId: config.strategyPack,
            side,
            action: candidate?.action ?? "WATCH",
            confidence,
            status: candidate ? "candidate" : "watch",
            thesis: candidate?.rationale ?? `${side} bias from ${config.strategyPack} with fair APR ${row.fair_apr.toFixed(4)}`,
            evidenceJson: JSON.stringify({
              fairApr: row.fair_apr,
              edgeBpsLong: row.edge_bps_long,
              edgeBpsShort: row.edge_bps_short,
            }),
          };
        })
        .filter(Boolean)
        .sort((a, b) => (b!.confidence - a!.confidence))
        .slice(0, 10) as Array<{
          recordedAt: number;
          marketId: number;
          marketName: string;
          strategyId: string;
          side: string;
          action: string;
          confidence: number;
          status: string;
          thesis: string;
          evidenceJson: string;
        }>;

      this.store.replaceRecommendations(recommendations);
    } finally {
      db.close();
    }
  }

  /** Track recently rejected market+action combos to suppress duplicate noise. */
  private recentRejections = new Map<string, number>();

  private syncOrdersToActions(): void {
    const db = this.openTraderDb();
    if (!db) {
      return;
    }
    try {
      // Build a market_id → market_name lookup from the latest snapshots
      const nameRows = db.prepare(`
        SELECT market_id, market_name FROM market_snapshots
        GROUP BY market_id
        HAVING recorded_at = MAX(recorded_at)
      `).all() as Array<{ market_id: number; market_name: string }>;
      const marketNames = new Map<number, string>();
      for (const nr of nameRows) {
        marketNames.set(nr.market_id, nr.market_name);
      }

      const rows = db.prepare(`
        SELECT id, recorded_at, market_id, side, action, status, notes, net_edge_bps
        FROM orders
        WHERE id > ?
        ORDER BY id ASC
      `).all(this.lastSyncedOrderId) as SqliteOrderRow[];
      for (const row of rows) {
        this.lastSyncedOrderId = Math.max(this.lastSyncedOrderId, row.id);

        // Deduplicate rejected/skipped orders — only record once per market+action per 10 minutes
        const isNoise = row.status === "rejected" || row.status === "skipped";
        if (isNoise) {
          const dedupeKey = `${row.market_id}:${row.action}:${row.side}`;
          const lastSeen = this.recentRejections.get(dedupeKey) ?? 0;
          if (Date.now() - lastSeen < 600_000) {
            continue; // skip duplicate rejection — already recorded recently
          }
          this.recentRejections.set(dedupeKey, Date.now());
        }

        const name = marketNames.get(row.market_id) ?? `Market ${row.market_id}`;
        this.store.recordAction(
          row.action.toLowerCase(),
          row.status.toLowerCase(),
          `${row.action} ${row.side} on ${name} (${row.net_edge_bps.toFixed(1)}bps)`,
          row,
          row.market_id,
          name,
        );
      }
    } finally {
      db.close();
    }
  }

  private syncResearch(): void {
    const db = this.openTraderDb();
    if (!db) {
      return;
    }
    try {
      const positions = db.prepare(`
        SELECT market_id, market_name, side, status
        FROM positions
        WHERE status = 'OPEN'
        ORDER BY opened_at ASC
      `).all() as SqlitePositionRow[];
      const recommendations = this.store.getRecommendations(3);
      const summary = recommendations.length === 0
        ? "Monitoring Boros markets with no high-confidence candidates right now."
        : `Top setup: ${recommendations[0].marketName ?? `Market ${recommendations[0].marketId}`} ${recommendations[0].side} at ${(recommendations[0].confidence * 100).toFixed(0)}% confidence.`;
      const active = positions.length === 0
        ? "No current managed positions."
        : `Open positions: ${positions.map((p) => `${p.market_name} ${p.side}`).join(", ")}.`;
      const leaderboard = this.readLeaderboardSnapshot();
      const topTraders = leaderboard.length === 0
        ? "No 30d leaderboard data cached yet."
        : `Top 30d traders: ${leaderboard.slice(0, 3).map((entry) => `${entry.address.slice(0, 6)}...${entry.address.slice(-4)} ${entry.return30d != null ? `${(entry.return30d * 100).toFixed(1)}%` : "n/a"}`).join(", ")}.`;
      const title = "Autonomous Boros research snapshot";
      const latest = this.store.getResearch(1)[0];
      const body = `${summary} ${active} ${topTraders}`;
      if (!latest || latest.summary !== body) {
        this.store.addResearch(title, body, {
          recommendations: recommendations.length,
          positions: positions.length,
          topTraders: leaderboard.slice(0, 5),
        });
      }
    } finally {
      db.close();
    }
  }

  private async runAcpDecisionIfNeeded(): Promise<void> {
    const config = this.store.getConfig();
    if (!config.acpEnabled || !this.status.deployed || this.status.runtimeState !== "running") {
      return;
    }
    const acp = this.readAcpStatus();
    const hasClaudeFallback = !!process.env.ANTHROPIC_API_KEY;
    if ((!acp.authenticated && !hasClaudeFallback) || this.decisionInFlight) {
      return;
    }
    const now = Date.now();
    const baseIntervalMs = Math.max(120_000, config.pollingIntervalMs * 2);
    // Exponential backoff on consecutive failures: 2min, 4min, 8min, 16min, cap at 30min
    const backoffMultiplier = Math.min(Math.pow(2, this.consecutiveDecisionFailures), 15);
    const minIntervalMs = baseIntervalMs * backoffMultiplier;
    if (now - this.lastDecisionAt < minIntervalMs) {
      return;
    }

    this.decisionInFlight = true;
    this.lastDecisionAt = now;
    try {
      const decision = await this.runAcpDecision(config);
      if (!decision) {
        return;
      }
      this.consecutiveDecisionFailures = 0; // Reset on success
      this.applyAcpDecision(config, decision);
    } catch (error) {
      this.consecutiveDecisionFailures++;
      const nextRetryMin = Math.round((baseIntervalMs * Math.min(Math.pow(2, this.consecutiveDecisionFailures), 15)) / 60_000);
      this.recordAudit("error", "acp", "ACP decision loop failed", { error: String(error), failures: this.consecutiveDecisionFailures, nextRetryMin });
      this.pushLog(`[acp] decision failed (${this.consecutiveDecisionFailures}x, next retry in ~${nextRetryMin}min): ${String(error).slice(0, 120)}`);
    } finally {
      this.decisionInFlight = false;
    }
  }

  private buildDecisionContext(
    config: AgentConfig,
    accountInfo?: { equityUsd: number; availableBalanceUsd: number; initialMarginUsedUsd: number },
    externalFundingRates?: Array<{ source: string; symbol: string; fundingRate: number; nextFundingTime?: number }>,
    marketSentiment?: Record<string, unknown> | null,
  ): string {
    const db = this.openTraderDb();
    const positions = db
      ? db.prepare(`
          SELECT market_id, market_name, side, status, entry_apr, current_apr, floating_apr,
                 size_base, notional_usd, initial_margin_usd, unrealized_pnl_usd,
                 realized_carry_pnl_usd, realized_trading_pnl_usd, liquidation_buffer_bps,
                 add_count, last_signal_edge_bps
          FROM positions
          WHERE status = 'OPEN'
          ORDER BY opened_at ASC
          LIMIT 10
        `).all() as SqlitePositionRow[]
      : [];
    const signals = db
      ? db.prepare(`
          SELECT recorded_at, market_id, fair_apr, edge_bps_long, edge_bps_short, candidate_json
          FROM signals
          ORDER BY recorded_at DESC
          LIMIT 250
        `).all() as SqliteSignalRow[]
      : [];
    const snapshots = db
      ? db.prepare(`
          SELECT recorded_at, market_id, market_name, asset_symbol, platform_name, mid_apr,
                 floating_apr, futures_premium, underlying_apr_7d, underlying_apr_30d,
                 best_bid_apr, best_ask_apr, best_long_size_base, best_short_size_base,
                 time_to_maturity_seconds, asset_mark_price, raw_json
          FROM market_snapshots
          ORDER BY recorded_at DESC
          LIMIT 500
        `).all() as SqliteSnapshotRow[]
      : [];
    const recentOrders = db
      ? db.prepare(`
          SELECT id, recorded_at, market_id, side, action, status, notes, net_edge_bps
          FROM orders
          ORDER BY recorded_at DESC
          LIMIT 20
        `).all() as SqliteOrderRow[]
      : [];

    const performanceSummary = db
      ? (() => {
          const allOrders = db.prepare(`
            SELECT action, status, net_edge_bps FROM orders
            WHERE recorded_at > ? AND status IN ('FILLED', 'PARTIAL')
          `).all(Math.floor(Date.now() / 1000) - 30 * 86400) as Array<{ action: string; status: string; net_edge_bps: number }>;
          const wins = allOrders.filter((o) => o.net_edge_bps > 0).length;
          const losses = allOrders.filter((o) => o.net_edge_bps <= 0).length;
          const avgEdgeBps = allOrders.length > 0 ? allOrders.reduce((s, o) => s + o.net_edge_bps, 0) / allOrders.length : 0;
          const bestEdge = allOrders.length > 0 ? Math.max(...allOrders.map((o) => o.net_edge_bps)) : 0;
          const worstEdge = allOrders.length > 0 ? Math.min(...allOrders.map((o) => o.net_edge_bps)) : 0;

          const intentStats = db.prepare(`
            SELECT status, COUNT(*) as cnt FROM agent_execution_intents
            WHERE recorded_at > ?
            GROUP BY status
          `).all(Math.floor(Date.now() / 1000) - 7 * 86400) as Array<{ status: string; cnt: number }>;
          const intentApplied = intentStats.find((r) => r.status === "APPLIED")?.cnt ?? 0;
          const intentRejected = intentStats.find((r) => r.status === "REJECTED")?.cnt ?? 0;
          const intentExpired = intentStats.find((r) => r.status === "EXPIRED")?.cnt ?? 0;

          return {
            totalTrades30d: allOrders.length,
            wins,
            losses,
            winRate: allOrders.length > 0 ? wins / allOrders.length : 0,
            avgNetEdgeBps: Math.round(avgEdgeBps * 100) / 100,
            bestEdgeBps: bestEdge,
            worstEdgeBps: worstEdge,
            intents7d: { applied: intentApplied, rejected: intentRejected, expired: intentExpired },
          };
        })()
      : null;

    const riskState = (() => {
      const openPositions = positions.filter((p) => p.status === "OPEN");
      const totalMarginUsed = openPositions.reduce((s, p) => s + (p.initial_margin_usd ?? 0), 0);
      const totalUnrealizedPnl = openPositions.reduce((s, p) => s + (p.unrealized_pnl_usd ?? 0), 0);

      const storedRisk = db?.prepare(`SELECT value FROM runtime_state WHERE key = 'risk_state'`).get() as { value: string } | undefined;
      const engineRisk = storedRisk ? safeParseJson(storedRisk.value) as { equityUsd?: number } | null : null;
      const equityUsd = accountInfo?.equityUsd ?? engineRisk?.equityUsd ?? 0;

      const remainingBudget = equityUsd * config.maxTotalMarginPct - totalMarginUsed;

      const dailyBaseline = db?.prepare(`SELECT value FROM runtime_state WHERE key = ?`).get(`baseline:${new Date().toISOString().slice(0, 10)}`) as { value: string } | undefined;
      const baselineEquity = dailyBaseline ? Number(JSON.parse(dailyBaseline.value)) : equityUsd;
      const dailyPnlPct = baselineEquity > 0 ? (equityUsd - baselineEquity) / baselineEquity : 0;

      const failureStreakRow = db?.prepare(`SELECT value FROM runtime_state WHERE key = 'failure_streak'`).get() as { value: string } | undefined;
      const failureStreak = failureStreakRow ? Number(JSON.parse(failureStreakRow.value)) : 0;

      const killSwitchRow = db?.prepare(`SELECT value FROM runtime_state WHERE key = 'kill_switch_active'`).get() as { value: string } | undefined;
      const killSwitchActive = killSwitchRow ? JSON.parse(killSwitchRow.value) === true : false;

      return {
        equityUsd: Math.round(equityUsd * 100) / 100,
        usedMarginUsd: Math.round(totalMarginUsed * 100) / 100,
        remainingBudgetUsd: Math.round(Math.max(0, remainingBudget) * 100) / 100,
        unrealizedPnlUsd: Math.round(totalUnrealizedPnl * 100) / 100,
        dailyPnlPct: Math.round(dailyPnlPct * 10000) / 10000,
        failureStreak,
        killSwitchActive,
        openPositionCount: openPositions.length,
        maxPositions: config.maxPositions,
      };
    })();

    const recentDecisions = this.store.getResearch(5)
      .filter((r) => r.title.toLowerCase().includes("acp decision") || r.title.toLowerCase().includes("decision"))
      .map((r) => ({
        recordedAt: r.recordedAt,
        title: r.title,
        summary: truncateForPrompt(r.summary, 500),
      }));

    const recentIntentOutcomes = db
      ? db.prepare(`
          SELECT action, confidence, status, status_reason, market_name, thesis
          FROM agent_execution_intents
          WHERE status != 'PENDING'
          ORDER BY applied_at DESC
          LIMIT 15
        `).all() as Array<{ action: string; confidence: number; status: string; status_reason: string | null; market_name: string | null; thesis: string }>
      : [];

    const failureAnalysis = analyzeIntentFailures(recentIntentOutcomes);

    db?.close();

    this.store.pruneExpiredMemories();
    const agentMemories = this.store.getMemories(30).map((m) => ({
      category: m.category,
      key: m.key,
      content: m.content,
      confidence: m.confidence,
      updatedAt: m.updatedAt,
    }));

    const latestSignals = new Map<number, SqliteSignalRow>();
    for (const row of signals) {
      if (!latestSignals.has(row.market_id)) {
        latestSignals.set(row.market_id, row);
      }
    }

    const latestSnapshots = new Map<number, SqliteSnapshotRow>();
    for (const row of snapshots) {
      if (!latestSnapshots.has(row.market_id)) {
        latestSnapshots.set(row.market_id, row);
      }
    }

    const timeSeriesByMarket = new Map<number, SqliteSnapshotRow[]>();
    for (const row of snapshots) {
      const existing = timeSeriesByMarket.get(row.market_id) ?? [];
      if (existing.length < 24) {
        existing.push(row);
        timeSeriesByMarket.set(row.market_id, existing);
      }
    }

    const marketPayload = [...new Set([...latestSignals.keys(), ...latestSnapshots.keys()])]
      .map((marketId) => {
        const signal = latestSignals.get(marketId);
        const snapshot = latestSnapshots.get(marketId);
        const candidate = signal?.candidate_json ? safeParseJson(signal.candidate_json) : null;
        const longEdge = signal?.edge_bps_long ?? null;
        const shortEdge = signal?.edge_bps_short ?? null;
        const grossEdge = Math.max(Math.abs(longEdge ?? 0), Math.abs(shortEdge ?? 0));
        const rawSnapshot = (snapshot?.raw_json ? safeParseJson(snapshot.raw_json) : null) as {
          imData?: {
            marginFloor?: number | null;
          };
          metadata?: {
            maxLeverage?: number | null;
            defaultLeverage?: number | null;
          };
          data?: {
            nextSettlementTime?: number | null;
            markApr?: number | null;
            longYieldApr?: number | null;
            volume24h?: number | null;
            notionalOI?: number | null;
            notionalOi?: number | null;
          };
          extConfig?: {
            paymentPeriod?: number | null;
          };
        } | null;
        return {
          marketId,
          marketName: snapshot?.market_name ?? (candidate?.marketName as string | undefined) ?? `Market ${marketId}`,
          assetSymbol: snapshot?.asset_symbol ?? null,
          platformName: snapshot?.platform_name ?? null,
          marketSnapshot: snapshot ? {
            recordedAt: snapshot.recorded_at,
            midApr: snapshot.mid_apr,
            floatingApr: snapshot.floating_apr,
            futuresPremium: snapshot.futures_premium,
            underlyingApr7d: snapshot.underlying_apr_7d,
            underlyingApr30d: snapshot.underlying_apr_30d,
            bestBidApr: snapshot.best_bid_apr,
            bestAskApr: snapshot.best_ask_apr,
            bestLongSizeBase: snapshot.best_long_size_base,
            bestShortSizeBase: snapshot.best_short_size_base,
            bestLongNotionalUsd: snapshot.best_long_size_base != null && snapshot.asset_mark_price
              ? Math.round(snapshot.best_long_size_base * snapshot.asset_mark_price * 100) / 100
              : null,
            bestShortNotionalUsd: snapshot.best_short_size_base != null && snapshot.asset_mark_price
              ? Math.round(snapshot.best_short_size_base * snapshot.asset_mark_price * 100) / 100
              : null,
            timeToMaturitySeconds: snapshot.time_to_maturity_seconds,
            assetMarkPrice: snapshot.asset_mark_price,
            marginFloorPct: rawSnapshot?.imData?.marginFloor ?? null,
            maxLeverage: rawSnapshot?.metadata?.maxLeverage ?? null,
            defaultLeverage: rawSnapshot?.metadata?.defaultLeverage ?? null,
            minMarginForMinNotionalUsd: rawSnapshot?.imData?.marginFloor
              ? Math.ceil(10 * rawSnapshot.imData.marginFloor * 100) / 100
              : null,
            rawView: rawSnapshot ? {
              nextSettlementTime: rawSnapshot.data?.nextSettlementTime ?? null,
              markApr: rawSnapshot.data?.markApr ?? null,
              longYieldApr: rawSnapshot.data?.longYieldApr ?? null,
              volume24h: rawSnapshot.data?.volume24h ?? null,
              notionalOi: rawSnapshot.data?.notionalOI ?? rawSnapshot.data?.notionalOi ?? null,
              paymentPeriodSeconds: rawSnapshot.extConfig?.paymentPeriod ?? null,
            } : null,
          } : null,
          engineView: signal ? {
            recordedAt: signal.recorded_at,
            fairApr: signal.fair_apr,
            edgeBpsLong: signal.edge_bps_long,
            edgeBpsShort: signal.edge_bps_short,
            grossEdgeBps: grossEdge,
            candidateSide: candidate?.side ?? null,
            candidateAction: candidate?.action ?? null,
            candidateIntent: candidate?.orderIntent ?? null,
            candidateNetEdgeBps: candidate?.netEdgeBps ?? null,
            candidateOrderApr: candidate?.orderApr ?? null,
            candidateSizeBase: candidate?.sizeBase ?? null,
            candidateNotionalUsd: candidate?.notionalUsd ?? null,
            candidatePlannedMarginUsd: candidate?.plannedMarginUsd ?? null,
            candidateRationale: candidate?.rationale ?? null,
          } : null,
          recentRates: (timeSeriesByMarket.get(marketId) ?? []).map((s) => ({
            recordedAt: s.recorded_at,
            midApr: s.mid_apr,
            floatingApr: s.floating_apr,
            bestBidApr: s.best_bid_apr,
            bestAskApr: s.best_ask_apr,
          })),
        };
      })
      .sort((left, right) => {
        const rightEdge = right.engineView?.grossEdgeBps ?? 0;
        const leftEdge = left.engineView?.grossEdgeBps ?? 0;
        return rightEdge - leftEdge;
      })
      .slice(0, 20);

    const recentExecution = recentOrders.map((row) => ({
      id: row.id,
      recordedAt: row.recorded_at,
      marketId: row.market_id,
      side: row.side,
      action: row.action,
      status: row.status,
      netEdgeBps: row.net_edge_bps,
      notes: row.notes,
    }));

    const recentWalletResearch = this.store.getWalletResearch(10).map((item: AgentWalletResearch) => ({
      address: item.address,
      recordedAt: item.recordedAt,
      source: item.source,
      summary: item.summary,
      payload: safeParseJson(item.payloadJson),
    }));

    const topSignals = signals.slice(0, 25).map((row) => {
      const candidate = row.candidate_json ? safeParseJson(row.candidate_json) : null;
      return {
        marketId: row.market_id,
        marketName: (candidate?.marketName as string | undefined) ?? `Market ${row.market_id}`,
        fairApr: row.fair_apr,
        edgeBpsLong: row.edge_bps_long,
        edgeBpsShort: row.edge_bps_short,
        currentCandidateSide: candidate?.side ?? null,
        currentCandidateAction: candidate?.action ?? null,
      };
    });

    const leaderboard = this.readLeaderboardSnapshot().slice(0, 10);

    return [
      this.loadBorosSkillContext(),
      "",
      "Live Decision Context:",
      JSON.stringify(
        {
          now: new Date().toISOString(),
          goal: "Maximize Boros-only risk-adjusted returns autonomously within UI guardrails. Prefer actionable market focus and strategy selection over chatter.",
          config,
          engineConstraints: {
            minOrderNotionalUsd: Number(process.env.BOROS_MIN_ORDER_NOTIONAL_USD ?? 10),
            minEdgeBps: Number(process.env.BOROS_MIN_EDGE_BPS ?? 150),
            minLiquidityCoverage: Number(process.env.BOROS_MIN_LIQUIDITY_COVERAGE ?? 3),
            startingEquityUsd: Number(process.env.BOROS_STARTING_EQUITY_USD ?? 100_000),
            note: "Markets where bestLongNotionalUsd or bestShortNotionalUsd < minOrderNotionalUsd cannot be traded. Do NOT recommend markets with insufficient book depth.",
          },
          accountInfo: accountInfo ?? null,
          riskState,
          performanceSummary,
          openPositions: positions,
          marketPayload,
          recentExecution,
          topSignals,
          topTraders30d: leaderboard,
          recentWalletResearch,
          recentDecisions,
          recentIntentOutcomes,
          failureAnalysis,
          agentMemories,
          externalFundingRates: externalFundingRates?.length ? externalFundingRates : null,
          marketSentiment: marketSentiment ?? null,
        },
        null,
        2,
      ),
    ].join("\n");
  }

  private async fetchExternalFundingRates(): Promise<Array<{ source: string; symbol: string; fundingRate: number; nextFundingTime?: number }>> {
    const results: Array<{ source: string; symbol: string; fundingRate: number; nextFundingTime?: number }> = [];

    // Binance perpetual funding rates — all Boros underlyings (per-symbol to handle geo-block gracefully)
    const binanceSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "XAUUSDT", "XAGUSDT"];
    try {
      for (const symbol of binanceSymbols) {
        const resp = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) break;
        const item = await resp.json() as { symbol?: string; lastFundingRate?: string; nextFundingTime?: number; code?: number };
        if (item.code || !item.lastFundingRate) break;
        results.push({
          source: "binance_perp",
          symbol: item.symbol ?? symbol,
          fundingRate: parseFloat(item.lastFundingRate),
          nextFundingTime: item.nextFundingTime,
        });
      }
    } catch { /* geo-blocked, timeout, or network error */ }

    // Hyperliquid funding rates
    try {
      const resp = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json() as [{ universe: Array<{ name: string }> }, Array<{ funding: string }>];
        const [meta, contexts] = data;
        const hlSymbols = new Set(["BTC", "ETH", "SOL", "XRP", "HYPE", "BNB"]);
        for (let i = 0; i < meta.universe.length && i < contexts.length; i++) {
          if (hlSymbols.has(meta.universe[i].name)) {
            results.push({
              source: "hyperliquid_perp",
              symbol: meta.universe[i].name,
              fundingRate: parseFloat(contexts[i].funding),
            });
          }
        }
      }
    } catch { /* timeout or network error */ }

    return results;
  }

  private async fetchMarketSentiment(): Promise<Record<string, unknown> | null> {
    const sentiment: Record<string, unknown> = {};

    // Crypto Fear & Greed Index
    try {
      const resp = await fetch("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const data = await resp.json() as { data?: Array<{ value: string; value_classification: string }> };
        const entry = data.data?.[0];
        if (entry) {
          sentiment.fearGreedIndex = { value: Number(entry.value), classification: entry.value_classification };
        }
      }
    } catch { /* timeout */ }

    // CoinGecko global market data
    try {
      const resp = await fetch("https://api.coingecko.com/api/v3/global", { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const data = await resp.json() as { data?: Record<string, unknown> };
        const g = data.data as { total_market_cap?: Record<string, number>; total_volume?: Record<string, number>; market_cap_percentage?: Record<string, number>; market_cap_change_percentage_24h_usd?: number } | undefined;
        if (g) {
          sentiment.globalMarket = {
            totalMarketCapUsd: g.total_market_cap?.usd ?? null,
            totalVolume24hUsd: g.total_volume?.usd ?? null,
            btcDominancePct: g.market_cap_percentage?.btc ?? null,
            marketCapChange24hPct: g.market_cap_change_percentage_24h_usd ?? null,
          };
        }
      }
    } catch { /* timeout */ }

    // Pendle TVL from DeFi Llama
    try {
      const resp = await fetch("https://api.llama.fi/protocol/pendle", { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const data = await resp.json() as { currentChainTvls?: Record<string, number> };
        if (data.currentChainTvls) {
          const chains = data.currentChainTvls;
          sentiment.pendleTvl = {
            ethereum: chains["Ethereum"] ?? null,
            arbitrum: chains["Arbitrum"] ?? null,
            hyperliquid: chains["Hyperliquid L1"] ?? null,
            binance: chains["Binance"] ?? null,
            base: chains["Base"] ?? null,
            totalApprox: Object.entries(chains)
              .filter(([k]) => !k.includes("pool2") && !k.includes("staking"))
              .reduce((s, [, v]) => s + (v ?? 0), 0),
          };
        }
      }
    } catch { /* timeout */ }

    // Trending coins (what's hot right now)
    try {
      const resp = await fetch("https://api.coingecko.com/api/v3/search/trending", { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const data = await resp.json() as { coins?: Array<{ item: { symbol: string; name: string; market_cap_rank?: number } }> };
        sentiment.trendingCoins = (data.coins ?? []).slice(0, 7).map((c) => ({
          symbol: c.item.symbol,
          name: c.item.name,
          rank: c.item.market_cap_rank ?? null,
        }));
      }
    } catch { /* timeout */ }

    // Spot prices + 24h change for assets Boros trades
    try {
      const resp = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,binancecoin,tether-gold&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true",
        { signal: AbortSignal.timeout(3000) },
      );
      if (resp.ok) {
        const data = await resp.json() as Record<string, { usd?: number; usd_24h_change?: number; usd_24h_vol?: number }>;
        sentiment.spotPrices = Object.fromEntries(
          Object.entries(data).map(([asset, info]) => [asset, {
            priceUsd: info.usd ?? null,
            change24hPct: info.usd_24h_change != null ? Math.round(info.usd_24h_change * 100) / 100 : null,
            volume24hUsd: info.usd_24h_vol != null ? Math.round(info.usd_24h_vol) : null,
          }]),
        );
      }
    } catch { /* timeout */ }

    // DeFi Llama yields — top Pendle pools for rate comparison
    try {
      const resp = await fetch("https://yields.llama.fi/pools", { signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const data = await resp.json() as { data?: Array<{ project: string; symbol: string; apy: number; tvlUsd: number; chain: string }> };
        const pendlePools = (data.data ?? [])
          .filter((p) => p.project === "pendle" && p.tvlUsd > 500_000)
          .sort((a, b) => b.tvlUsd - a.tvlUsd)
          .slice(0, 10)
          .map((p) => ({
            symbol: p.symbol,
            chain: p.chain,
            apyPct: Math.round(p.apy * 100) / 100,
            tvlUsd: Math.round(p.tvlUsd),
          }));
        if (pendlePools.length > 0) {
          sentiment.pendleYields = pendlePools;
        }
      }
    } catch { /* timeout */ }

    return Object.keys(sentiment).length > 0 ? sentiment : null;
  }

  private async runAcpDecision(config: AgentConfig): Promise<AgentDecision | null> {
    const outputPath = path.join(this.rootDir, "data", "agent_decision_output.json");
    let accountInfo: { equityUsd: number; availableBalanceUsd: number; initialMarginUsedUsd: number } | undefined;
    try {
      const secrets = this.secretStore.resolve();
      if (secrets.rootAddress && secrets.accountId) {
        const resp = await fetch(`http://localhost:3142/api/account`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json() as { equity?: number; availableBalance?: number; initialMarginUsed?: number };
          accountInfo = {
            equityUsd: data.equity ?? 0,
            availableBalanceUsd: data.availableBalance ?? 0,
            initialMarginUsedUsd: data.initialMarginUsed ?? 0,
          };
        }
      }
    } catch {
      // Account fetch failed, continue with engine-stored data
    }

    let externalFundingRates: Array<{ source: string; symbol: string; fundingRate: number; nextFundingTime?: number }> = [];
    let marketSentiment: Record<string, unknown> | null = null;
    if (config.openWebResearch) {
      const [rates, sentiment] = await Promise.all([
        this.fetchExternalFundingRates().catch(() => []),
        this.fetchMarketSentiment().catch(() => null),
      ]);
      externalFundingRates = rates;
      marketSentiment = sentiment;
      const fetched: string[] = [];
      if (externalFundingRates.length > 0) fetched.push(`${externalFundingRates.length} funding rates`);
      if (marketSentiment) fetched.push(`sentiment (F&G: ${(marketSentiment.fearGreedIndex as { value?: number })?.value ?? "?"})`);
      if (fetched.length > 0) this.pushLog(`[acp] web research: ${fetched.join(", ")}`);
    }

    const prompt = [
      "You are the autonomous Boros trading agent brain.",
      "Decide which Boros-native strategy pack to use right now, which markets to focus on, and whether the engine should run close-only.",
      "Stay within the provided guardrails. Do not invent unsupported strategies. Use only Boros-native approaches.",
      "Prefer concise, decisive output. If opportunity quality is weak, choose an empty allowlist and/or closeOnly=true.",
      "If you choose REDUCE, include the intended trim size in the thesis, e.g. 'reduce 50%' or 'trim 25%'.",
      "IMPORTANT: Check bestLongNotionalUsd and bestShortNotionalUsd for each market. If below engineConstraints.minOrderNotionalUsd ($10), the market is untradeable — do NOT recommend it. Only recommend markets with sufficient on-chain liquidity.",
      "You have persistent memory. Review your memories and update them as needed.",
      "To save a memory, include it in memoryUpdates. To remove an outdated memory, include it in memoryDeletes.",
      "Use memories to avoid repeating mistakes and build on past learnings.",
      "Review the failureAnalysis section. If failures are recurring, adjust your strategy — change markets, sizes, or use parameterAdjustments to self-tune.",
      "parameterAdjustments lets you live-tune: confidenceThreshold, maxPositions, maxDailyDrawdownPct, pollingIntervalMs, leverageCap, marginUtilizationTargetPct, maxInitialMarginPctPerMarket, maxTotalMarginPct, takeProfitPct, stopLossPct, trailingStopArmPct, trailingStopGivebackPct. All bounded. Use this to adapt to market conditions — tighten stops in volatile markets, widen TP in trending markets, reduce leverage in fear, increase positions when opportunities are plentiful.",
      "If externalFundingRates is present, compare Boros implied rates against CEX perp funding rates. A large divergence (Boros implied >> CEX funding) signals short opportunity; the reverse signals long opportunity.",
      "If marketSentiment is present, factor it into risk sizing: Fear & Greed below 25 = extreme fear (be cautious, tighten stops); above 75 = extreme greed (watch for reversals). Use Pendle TVL trends and trending coins for context on where capital is flowing.",
      "You can manage collateral across isolated and cross margin via collateralOps. Actions: DEPOSIT_ISOLATED (move USD from cross to isolated market — requires marketId and amountUsd), WITHDRAW_ISOLATED (pull collateral back from isolated market — requires marketId), SWEEP_ALL_ISOLATED (pull all isolated collateral back to cross). Only use these when needed — e.g. before entering an isolated market, or to reclaim idle capital from closed positions.",
      "Return only structured output matching the schema.",
      "",
      "Allowed strategy packs:",
      "- relative_value",
      "- settlement_sniper",
      "- negative_funding",
      "- cross_market",
      "",
      "Context:",
      this.buildDecisionContext(config, accountInfo, externalFundingRates, marketSentiment),
    ].join("\n");

    // Try Codex (OpenAI) first, fall back to Claude if it fails
    let parsed: AgentDecision | null = null;
    let usedProvider = "codex";

    const acp = this.readAcpStatus();
    if (acp.authenticated) {
      try {
        parsed = await this.runCodexDecision(prompt, outputPath);
      } catch (codexError) {
        const errMsg = String(codexError);
        this.pushLog(`[acp] codex failed, trying claude fallback: ${errMsg.slice(0, 120)}`);
        this.recordAudit("warn", "acp", "Codex ACP failed, falling back to Claude", { error: errMsg.slice(0, 500) });
      }
    }

    if (!parsed && process.env.ANTHROPIC_API_KEY) {
      usedProvider = "claude";
      parsed = await this.runClaudeDecision(prompt);
    }

    if (!parsed) {
      throw new Error("Both Codex and Claude decision providers failed (no ANTHROPIC_API_KEY set for fallback)");
    }

    this.pushLog(`[acp:${usedProvider}] strategy=${parsed.strategyPack} allowlist=${parsed.marketAllowlist.join(",") || "none"} closeOnly=${parsed.closeOnly}`);
    return parsed;
  }

  private async runCodexDecision(prompt: string, outputPath: string): Promise<AgentDecision> {
    const args = [
      "/c",
      "codex",
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--output-schema",
      this.agentDecisionSchemaPath,
      "-o",
      outputPath,
      "-",
    ];

    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("cmd", args, {
        cwd: this.rootDir,
        env: process.env,
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("exit", (code) => resolve({ status: code, stdout, stderr }));
      child.stdin.write(prompt);
      child.stdin.end();
    });

    if (run.status !== 0) {
      throw new Error(`codex exec failed: ${normalizeOutput(`${run.stdout}\n${run.stderr}`)}`);
    }
    if (!fs.existsSync(outputPath)) {
      throw new Error("codex exec did not produce a decision payload");
    }

    const raw = fs.readFileSync(outputPath, "utf-8");
    return JSON.parse(raw) as AgentDecision;
  }

  private async runClaudeDecision(prompt: string): Promise<AgentDecision> {
    const schemaRaw = fs.readFileSync(this.agentDecisionSchemaPath, "utf-8");
    const schema = JSON.parse(schemaRaw);

    const client = new Anthropic();
    const preferredModel = process.env.BOROS_AGENT_CLAUDE_MODEL || "claude-sonnet-4-5-20241022";
    this.pushLog(`[acp:claude] calling ${preferredModel}...`);

    const response = await client.messages.create({
      model: preferredModel,
      max_tokens: 4096,
      system: "You are an autonomous trading agent brain. Return ONLY valid JSON matching the provided schema. No markdown, no commentary, just the JSON object.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${prompt}\n\nRespond with a JSON object matching this schema:\n${JSON.stringify(schema, null, 2)}`,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude returned no text content");
    }

    // Extract JSON from the response — handle possible markdown wrapping
    let jsonStr = textBlock.text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr) as AgentDecision;

    // Validate required fields
    if (!parsed.summary || !parsed.strategyPack || !Array.isArray(parsed.recommendations)) {
      throw new Error("Claude response missing required fields");
    }

    this.pushLog(`[acp:claude] decision received: ${parsed.summary.slice(0, 80)}`);
    return parsed;
  }

  private applyAcpDecision(currentConfig: AgentConfig, decision: AgentDecision): void {
    const nextConfig: AgentConfig = {
      ...currentConfig,
      strategyPack: decision.strategyPack,
      marketAllowlist: decision.marketAllowlist.join(","),
      closeOnly: decision.closeOnly,
      confidenceThreshold:
        decision.confidenceThreshold != null
          ? Math.max(0, Math.min(1, decision.confidenceThreshold))
          : currentConfig.confidenceThreshold,
    };

    this.store.addResearch("ACP decision", decision.summary, {
      rationale: decision.rationale,
      strategyPack: decision.strategyPack,
      marketAllowlist: decision.marketAllowlist,
      closeOnly: decision.closeOnly,
    });

    const recommendations = decision.recommendations.slice(0, 10).map((item) => ({
      recordedAt: Date.now(),
      marketId: item.marketId ?? undefined,
      marketName: item.marketName ?? (item.marketId ? `Market ${item.marketId}` : "Portfolio"),
      strategyId: decision.strategyPack,
      side: item.side ?? undefined,
      action: item.action,
      confidence: item.confidence,
      status: item.action === "WATCH" ? "watch" : "candidate",
      thesis: item.thesis,
      evidenceJson: JSON.stringify({
        summary: decision.summary,
        rationale: decision.rationale,
      }),
    }));
    this.store.replaceRecommendations(recommendations);

    if (decision.memoryUpdates?.length) {
      for (const mem of decision.memoryUpdates) {
        const expiresAt = mem.ttlHours ? Date.now() + mem.ttlHours * 3600_000 : undefined;
        this.store.upsertMemory(mem.category, mem.key, mem.content, mem.confidence ?? 0.5, expiresAt);
      }
      this.pushLog(`[acp] saved ${decision.memoryUpdates.length} memory entries`);
    }

    if (decision.memoryDeletes?.length) {
      for (const key of decision.memoryDeletes) {
        this.store.deleteMemory(key);
      }
      this.pushLog(`[acp] deleted ${decision.memoryDeletes.length} memory entries`);
    }

    if (decision.parameterAdjustments) {
      const adj = decision.parameterAdjustments;
      const bounds: Record<string, { min: number; max: number; round?: boolean; key: keyof AgentConfig }> = {
        confidenceThreshold: { min: 0.1, max: 0.95, key: "confidenceThreshold" },
        maxPositions: { min: 1, max: 10, round: true, key: "maxPositions" },
        maxDailyDrawdownPct: { min: 0.01, max: 0.25, key: "maxDailyDrawdownPct" },
        pollingIntervalMs: { min: 30_000, max: 600_000, round: true, key: "pollingIntervalMs" },
        leverageCap: { min: 1, max: 5, key: "leverageCap" },
        marginUtilizationTargetPct: { min: 0.3, max: 0.95, key: "marginUtilizationTargetPct" },
        maxInitialMarginPctPerMarket: { min: 0.02, max: 0.5, key: "maxInitialMarginPctPerMarket" },
        maxTotalMarginPct: { min: 0.1, max: 0.8, key: "maxTotalMarginPct" },
        takeProfitPct: { min: 0.05, max: 1.0, key: "takeProfitPct" },
        stopLossPct: { min: 0.03, max: 0.5, key: "stopLossPct" },
        trailingStopArmPct: { min: 0.03, max: 0.5, key: "trailingStopArmPct" },
        trailingStopGivebackPct: { min: 0.02, max: 0.3, key: "trailingStopGivebackPct" },
      };
      const applied: string[] = [];
      for (const [param, spec] of Object.entries(bounds)) {
        const value = (adj as Record<string, number | undefined>)[param];
        if (value != null) {
          const clamped = spec.round
            ? Math.round(Math.max(spec.min, Math.min(spec.max, value)))
            : Math.max(spec.min, Math.min(spec.max, value));
          (nextConfig as unknown as Record<string, unknown>)[spec.key] = clamped;
          applied.push(`${spec.key}=${clamped}`);
        }
      }
      if (applied.length > 0) {
        this.recordAudit("info", "acp", "Agent self-tuned parameters", { adjustments: applied });
        this.pushLog(`[acp] self-tuned: ${applied.join(", ")}`);
      }
    }

    this.replaceTraderIntents(decision);

    if (decision.collateralOps?.length) {
      this.recordAudit("info", "acp", `Queued ${decision.collateralOps.length} collateral operation(s)`, { ops: decision.collateralOps });
      this.pushLog(`[acp] queued ${decision.collateralOps.length} collateral op(s): ${decision.collateralOps.map((o) => o.action).join(", ")}`);
    }

    const configKeys: (keyof AgentConfig)[] = [
      "strategyPack", "marketAllowlist", "closeOnly", "confidenceThreshold",
      "maxPositions", "maxDailyDrawdownPct", "pollingIntervalMs", "leverageCap",
      "marginUtilizationTargetPct", "maxInitialMarginPctPerMarket", "maxTotalMarginPct",
      "takeProfitPct", "stopLossPct", "trailingStopArmPct", "trailingStopGivebackPct",
    ];
    const materiallyChanged = configKeys.some((k) => nextConfig[k] !== currentConfig[k]);

    this.recordAudit("info", "acp", "Applied ACP agent decision", {
      summary: decision.summary,
      strategyPack: decision.strategyPack,
      marketAllowlist: decision.marketAllowlist,
      closeOnly: decision.closeOnly,
      changed: materiallyChanged,
    });
    this.store.recordAction(
      "agent_decision",
      materiallyChanged ? "applied" : "observed",
      `${decision.strategyPack} | markets=${decision.marketAllowlist.join(",") || "all"} | closeOnly=${decision.closeOnly}`,
      decision,
    );

    if (!materiallyChanged) {
      return;
    }

    this.store.saveConfig(nextConfig);
    this.setStatus({
      mode: nextConfig.mode,
      closeOnly: nextConfig.closeOnly,
      lastError: undefined,
    });
    void this.start(nextConfig);
  }

  private replaceTraderIntents(decision: AgentDecision): void {
    this.withWritableTraderDb((db) => {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        UPDATE agent_execution_intents
        SET status = 'EXPIRED', status_reason = 'Superseded by newer ACP decision', applied_at = ?
        WHERE status = 'PENDING'
      `).run(now);

      const insert = db.prepare(`
        INSERT INTO agent_execution_intents (
          recorded_at, market_id, market_name, side, action, confidence, thesis, source, expires_at, status, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
      `);

      for (const item of decision.recommendations) {
        if (!item.marketId || item.action === "WATCH" || item.action === "HOLD") {
          continue;
        }
        const intent = {
          marketId: item.marketId,
          marketName: item.marketName ?? `Market ${item.marketId}`,
          side: item.side,
          action: item.action,
          confidence: item.confidence,
          thesis: item.thesis,
          source: "acp",
          expiresAt: now + Math.max(300, Math.floor(this.store.getConfig().pollingIntervalMs / 1000) * 3),
        };
        insert.run(
          now,
          intent.marketId,
          intent.marketName,
          intent.side ?? null,
          intent.action,
          intent.confidence,
          intent.thesis,
          intent.source,
          intent.expiresAt,
          JSON.stringify(intent),
        );
      }

      // Collateral operations
      if (decision.collateralOps?.length) {
        db.prepare(`
          UPDATE agent_collateral_intents
          SET status = 'EXPIRED', status_reason = 'Superseded by newer ACP decision', applied_at = ?
          WHERE status = 'PENDING'
        `).run(now);

        const insertCollateral = db.prepare(`
          INSERT INTO agent_collateral_intents (
            recorded_at, action, market_id, amount_usd, reason, status
          ) VALUES (?, ?, ?, ?, ?, 'PENDING')
        `);

        for (const op of decision.collateralOps) {
          insertCollateral.run(
            now,
            op.action,
            op.marketId ?? null,
            op.amountUsd ?? null,
            op.reason,
          );
        }
      }
    });
  }

  private readLeaderboardSnapshot(): LeaderboardSnapshot["entries"] {
    if (!fs.existsSync(this.leaderboardCachePath)) {
      return [];
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.leaderboardCachePath, "utf-8")) as LeaderboardSnapshot;
      return [...(raw.entries ?? [])]
        .filter((entry) => entry.return30d != null)
        .sort((a, b) => (b.return30d ?? -Infinity) - (a.return30d ?? -Infinity));
    } catch {
      return [];
    }
  }

  /** Advance the lastSyncedOrderId cursor to the current max so old orders are never re-synced. */
  private snapshotOrderCursor(): void {
    const db = this.openTraderDb();
    if (!db) return;
    try {
      const row = db.prepare("SELECT MAX(id) as maxId FROM orders").get() as { maxId: number | null } | undefined;
      if (row?.maxId) {
        this.lastSyncedOrderId = row.maxId;
      }
    } finally {
      db.close();
    }
  }

  private restoreIfNeeded(): void {
    // Always start clean — wipe old session data so UI only shows current run.
    // User deploys explicitly via the UI button or CLI flag.
    this.store.clearSessionData();
    // Advance order cursor past all existing orders so old data doesn't refill the actions panel.
    this.snapshotOrderCursor();
    this.recentRejections.clear();
    const status = this.store.getStatus();
    if (status.deployed || status.runtimeState === "running" || status.runtimeState === "paused" || status.runtimeState === "kill_switched") {
      this.store.finishLatestSession("stopped", "server restarted");
    }
    this.setStatus({ runtimeState: "ready", deployed: false });
    this.pushLog("[agent] Server started — click Deploy to start agent");
  }

  private applyRecoveryDefaults(config: AgentConfig): AgentConfig {
    const recovered = { ...config, closeOnly: true };
    const changes: string[] = ["closeOnly=true"];

    if (config.maxPositions > 2) {
      recovered.maxPositions = 2;
      changes.push(`maxPositions: ${config.maxPositions} → 2`);
    }
    if (config.maxDailyDrawdownPct > 0.05) {
      recovered.maxDailyDrawdownPct = 0.05;
      changes.push(`maxDailyDrawdownPct: ${config.maxDailyDrawdownPct} → 0.05`);
    }
    if (config.confidenceThreshold < 0.7) {
      recovered.confidenceThreshold = 0.7;
      changes.push(`confidenceThreshold: ${config.confidenceThreshold} → 0.7`);
    }

    this.recordAudit("warn", "health", "Recovering from kill switch with defensive parameters", { changes });
    this.pushLog(`[health] kill-switch recovery: ${changes.join(", ")}`);
    this.store.saveConfig(recovered);
    return recovered;
  }

  private buildTraderEnv(config: AgentConfig): NodeJS.ProcessEnv {
    const overrides = toEnvString(config);
    const secrets = this.secretStore.resolve();
    return {
      ...process.env,
      ...overrides,
      ...(secrets.rpcUrl ? { BOROS_RPC_URL: secrets.rpcUrl } : {}),
      ...(secrets.accountId ? { BOROS_ACCOUNT_ID: secrets.accountId } : {}),
      ...(secrets.rootAddress ? { BOROS_ROOT_ADDRESS: secrets.rootAddress } : {}),
      ...(secrets.privateKey ? { BOROS_PRIVATE_KEY: secrets.privateKey } : {}),
    };
  }

  async start(config = this.store.getConfig(), restoring = false): Promise<AgentStatus> {
    this.store.saveConfig(config);
    this.killSwitchOverridden = false;
    const validationErrors = this.validateDeploy(config);
    if (validationErrors.length > 0) {
      const message = validationErrors.join(" ");
      this.recordAudit("error", "deploy", "Agent deploy validation failed", validationErrors);
      this.setStatus({
        runtimeState: "error",
        deployed: false,
        mode: config.mode,
        closeOnly: config.closeOnly,
        lastError: message,
      });
      throw new Error(message);
    }
    await this.stop("restarting");

    // Fresh deploy — wipe stale actions/audit and advance cursor past old engine orders
    this.snapshotOrderCursor();
    this.recentRejections.clear();

    const env = this.buildTraderEnv(config);
    const isWindows = process.platform === "win32";
    const child = isWindows
      ? spawn("cmd", ["/c", "npx", "tsx", "src/index.ts"], {
          cwd: this.rootDir,
          env,
          stdio: "pipe",
        })
      : spawn("npx", ["tsx", "src/index.ts"], {
          cwd: this.rootDir,
          env,
          stdio: "pipe",
        });

    this.child = child;
    this.pushLog("Agent runtime started");
    this.setStatus({
      runtimeState: "running",
      deployed: true,
      closeOnly: config.closeOnly,
      mode: config.mode,
      process: { pid: child.pid, startedAt: Date.now(), lastHeartbeat: Date.now() },
      lastError: undefined,
    });
    this.store.startSession("running", config.mode, child.pid, config);
    this.recordAudit("info", "deploy", restoring ? "Restored agent runtime after restart" : "Deployed agent runtime", { config });
    this.startSyncLoop();

    child.stdout.on("data", (buffer) => {
      const lines = String(buffer).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        this.pushLog(line);
        if (line.includes("cycle complete")) {
          this.setStatus({ process: { lastHeartbeat: Date.now() } });
        }
      }
    });

    child.stderr.on("data", (buffer) => {
      const lines = String(buffer).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        this.pushLog(line);
        this.recordAudit("warn", "engine", line);
      }
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit ${code ?? 0}`;
      this.pushLog(`Agent runtime exited: ${reason}`);
      this.store.finishLatestSession("stopped", reason);
      const nextState: AgentRuntimeState = this.status.runtimeState === "paused" ? "paused" : "stopped";
      this.setStatus({
        runtimeState: nextState,
        process: {
          pid: undefined,
          lastExitCode: code ?? undefined,
          lastHeartbeat: Date.now(),
        },
        lastError: code && code !== 0 ? `Trader process exited with code ${code}` : undefined,
      });
      this.stopSyncLoop();
      this.child = null;
    });

    return this.status;
  }

  async stop(reason = "stopped"): Promise<AgentStatus> {
    if (this.child) {
      const proc = this.child;
      this.child = null;
      proc.kill("SIGTERM");
    }
    this.stopSyncLoop();
    this.store.finishLatestSession("stopped", reason);
    this.recordAudit("info", "lifecycle", `Agent stopped: ${reason}`);
    this.setStatus({
      runtimeState: "stopped",
      deployed: false,
      process: { pid: undefined, lastHeartbeat: Date.now() },
    });
    return this.status;
  }

  async pause(): Promise<AgentStatus> {
    await this.stop("paused");
    this.setStatus({
      runtimeState: "paused",
      deployed: true,
    });
    this.recordAudit("info", "lifecycle", "Agent paused");
    return this.status;
  }

  async resume(): Promise<AgentStatus> {
    const config = this.store.getConfig();
    this.recordAudit("info", "lifecycle", "Agent resumed");
    return this.start(config);
  }

  async setCloseOnly(closeOnly: boolean): Promise<AgentStatus> {
    const config = { ...this.store.getConfig(), closeOnly };
    this.store.saveConfig(config);
    if (!closeOnly) {
      this.killSwitchOverridden = true;
    }
    this.recordAudit("info", "risk", closeOnly ? "Enabled close-only mode" : "Disabled close-only mode (kill switch override)");
    if (this.status.deployed || this.status.runtimeState === "running") {
      return this.start(config);
    }
    this.setStatus({ closeOnly });
    return this.status;
  }

  saveConfig(config: AgentConfig): AgentConfig {
    this.store.saveConfig(config);
    this.recordAudit("info", "config", "Saved agent config", config);
    const validationErrors = this.validateDeploy(config);
    const runtimeState =
      validationErrors.length > 0
        ? "error"
        : this.status.runtimeState === "not_configured" || this.status.runtimeState === "error"
          ? "ready"
          : this.status.runtimeState;
    this.setStatus({
      mode: config.mode,
      closeOnly: config.closeOnly,
      runtimeState,
      lastError: validationErrors.length > 0 ? validationErrors.join(" ") : undefined,
    });
    return config;
  }

  getStatus(): AgentStatus {
    const s = this.withAcpStatus(this.status);
    s.claudeFallback = !!process.env.ANTHROPIC_API_KEY;
    return s;
  }

  getConfig(): AgentConfig {
    return this.store.getConfig();
  }

  getSecretsStatus(): AgentSecretsStatus {
    return this.currentSecretsStatus();
  }

  getLogs(): Array<{ ts: number; line: string }> {
    return this.recentLogs;
  }

  getResearch() {
    return this.store.getResearch();
  }

  getRecommendations() {
    return this.store.getRecommendations();
  }

  getActions() {
    return this.store.getActions();
  }

  getAudit() {
    return this.store.getAudit();
  }

  getMemories(limit?: number) {
    return this.store.getMemories(limit);
  }

  deleteMemory(key: string) {
    this.store.deleteMemory(key);
  }

  getWalletResearch(limit?: number) {
    return this.store.getWalletResearch(limit);
  }

  recordWalletResearch(address: string, payload: unknown): void {
    const typed = (payload ?? {}) as {
      positions?: Array<unknown>;
      performance?: { totalReturnPct?: number | null } | null;
      tradingActivity?: { totalOrders?: number | null } | null;
      account?: { equity?: number | null } | null;
    };
    const summary = [
      typed.account?.equity != null ? `equity=${Number(typed.account.equity).toFixed(2)}` : null,
      typed.positions ? `positions=${typed.positions.length}` : null,
      typed.performance?.totalReturnPct != null ? `return=${(Number(typed.performance.totalReturnPct) * 100).toFixed(1)}%` : null,
      typed.tradingActivity?.totalOrders != null ? `orders=${typed.tradingActivity.totalOrders}` : null,
    ].filter(Boolean).join(" | ") || "Wallet lookup cached";

    this.store.recordWalletResearch(address, "wallet_lookup", summary, payload);
  }

  dispose(): void {
    this.stopSyncLoop();
    this.child?.kill("SIGTERM");
    this.acpLoginChild?.kill("SIGTERM");
    this.store.close();
  }
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function registerAgentRoutes({ app, rootDir, traderSqlitePath }: CreateAgentControllerOptions): AgentRuntimeController {
  const controller = new AgentRuntimeController(rootDir, traderSqlitePath);

  app.get("/api/agent/status", (_req, res) => {
    res.json(controller.getStatus());
  });

  app.get("/api/agent/config", (_req, res) => {
    res.json(controller.getConfig());
  });

  app.post("/api/agent/config", (req, res) => {
    const config = { ...defaultAgentConfig(), ...(req.body as Partial<AgentConfig>) };
    controller.saveConfig(config);
    res.json({ ok: true, config });
  });

  app.get("/api/agent/secrets/status", (_req, res) => {
    res.json(controller.getSecretsStatus());
  });

  app.post("/api/agent/secrets", (req, res) => {
    try {
      const status = controller.saveSecrets(req.body as AgentSecretsInput);
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.delete("/api/agent/secrets", (_req, res) => {
    try {
      const status = controller.clearSecrets();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/agent/connect-acp", async (_req, res) => {
    try {
      const acp = await controller.startAcpDeviceAuth();
      res.json({ ok: true, acp });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/agent/deploy", async (req, res) => {
    try {
      const config = { ...defaultAgentConfig(), ...controller.getConfig(), ...(req.body as Partial<AgentConfig>) };
      const status = await controller.start(config);
      res.json({ ok: true, status });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/agent/pause", async (_req, res) => {
    res.json({ ok: true, status: await controller.pause() });
  });

  app.post("/api/agent/resume", async (_req, res) => {
    res.json({ ok: true, status: await controller.resume() });
  });

  app.post("/api/agent/stop", async (_req, res) => {
    res.json({ ok: true, status: await controller.stop("stopped by user") });
  });

  app.post("/api/agent/close-only", async (req, res) => {
    const closeOnly = Boolean(req.body?.closeOnly);
    res.json({ ok: true, status: await controller.setCloseOnly(closeOnly) });
  });

  app.get("/api/agent/research", (_req, res) => {
    res.json(controller.getResearch());
  });

  app.get("/api/agent/recommendations", (_req, res) => {
    res.json(controller.getRecommendations());
  });

  app.get("/api/agent/actions", (_req, res) => {
    res.json(controller.getActions());
  });

  app.get("/api/agent/audit", (_req, res) => {
    res.json(controller.getAudit());
  });

  app.get("/api/agent/logs", (_req, res) => {
    res.json(controller.getLogs());
  });

  app.get("/api/agent/memory", (_req, res) => {
    res.json(controller.getMemories());
  });

  app.delete("/api/agent/memory/:key", (req, res) => {
    controller.deleteMemory(req.params.key);
    res.json({ ok: true });
  });

  app.get("/api/agent/wallet-research", (_req, res) => {
    res.json(controller.getWalletResearch());
  });

  return controller;
}
