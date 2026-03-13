import { useEffect, useMemo, useState } from "react";
import type {
  AccountSummary,
  AgentActionIntent,
  AgentAuditEvent,
  AgentConfig,
  AgentRecommendation,
  AgentResearchNote,
  AgentSecretsStatus,
  AgentStatus,
  MarketsResponse,
  OnChainPositionsResponse,
  RiskState,
} from "../types";
import { usePolling } from "../hooks/usePolling";
import { fmtUsd } from "../utils/format";
import OnChainPositions from "./OnChainPositions";
import Panel from "./Panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

interface AgentModeProps {
  markets: MarketsResponse | null;
  account: AccountSummary | null;
  onChainPositions: OnChainPositionsResponse | null;
  onChainLoading: boolean;
  onChainUpdated: number | null;
  onChainError: string | null;
  onChainStale: boolean;
  riskState: RiskState | null;
}

const STRATEGY_OPTIONS: AgentConfig["strategyPack"][] = [
  "relative_value",
  "settlement_sniper",
  "negative_funding",
  "cross_market",
];

function MiniRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-border/20 last:border-b-0">
      <span className="text-[11px] tracking-wide text-text-muted">{label}</span>
      <span className="text-[12px] font-mono">{value}</span>
    </div>
  );
}

function parseEnabledStrategies(raw: string): string[] {
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

function normalizeAgentDraft(input: AgentConfig, enabledStrategiesInput: string): AgentConfig {
  const parsedEnabled = parseEnabledStrategies(enabledStrategiesInput);
  return {
    ...input,
    acpEnabled: true,
    openWebResearch: true,
    enabledStrategies: parsedEnabled.length > 0 ? parsedEnabled : STRATEGY_OPTIONS,
    allowEntries: true,
    allowAdds: true,
    allowReductions: true,
    allowCloses: true,
    allowCollateralOps: true,
    strategyPack: input.strategyPack ?? "relative_value",
  };
}

function hasReadinessBlockers(
  status: AgentStatus | null | undefined,
  secrets: AgentSecretsStatus | null | undefined,
  draft: AgentConfig | null,
): boolean {
  if (!draft) return true;
  // ACP is required unless Claude fallback is available (indicated by claudeFallback field on status)
  if (draft.acpEnabled && (!status?.acp.installed || !status.acp.authenticated) && !status?.claudeFallback) {
    return true;
  }
  if (draft.mode === "live" && !secrets?.configured) {
    return true;
  }
  return false;
}

export default function AgentMode({
  markets,
  account,
  onChainPositions,
  onChainLoading,
  onChainUpdated,
  onChainError,
  onChainStale,
  riskState,
}: AgentModeProps) {
  const status = usePolling<AgentStatus>("/api/agent/status", 5000);
  const config = usePolling<AgentConfig>("/api/agent/config", 10_000);
  const research = usePolling<AgentResearchNote[]>("/api/agent/research", 10_000);
  const recommendations = usePolling<AgentRecommendation[]>("/api/agent/recommendations", 10_000);
  const actions = usePolling<AgentActionIntent[]>("/api/agent/actions", 10_000);
  const audit = usePolling<AgentAuditEvent[]>("/api/agent/audit", 10_000);
  const logs = usePolling<Array<{ ts: number; line: string }>>("/api/agent/logs", 5000);
  const secrets = usePolling<AgentSecretsStatus>("/api/agent/secrets/status", 10_000);

  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [enabledStrategiesInput, setEnabledStrategiesInput] = useState("");
  const [secretDraft, setSecretDraft] = useState({
    rpcUrl: "",
    accountId: "",
    rootAddress: "",
    privateKey: "",
  });
  const [saveState, setSaveState] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    if (config.data) {
      setDraft(config.data);
      setEnabledStrategiesInput(config.data.enabledStrategies.join(", "));
    }
  }, [config.data]);

  const runtime = status.data;
  const secretStatus = secrets.data;
  const openCount = onChainPositions?.positions?.length ?? 0;

  const normalizedDraft = useMemo(
    () => (draft ? normalizeAgentDraft(draft, enabledStrategiesInput) : null),
    [draft, enabledStrategiesInput],
  );
  const deployBlocked = hasReadinessBlockers(runtime, secretStatus, normalizedDraft);

  const isDirty = useMemo(() => {
    if (!normalizedDraft || !config.data) return false;
    return JSON.stringify(normalizedDraft) !== JSON.stringify(config.data);
  }, [normalizedDraft, config.data]);

  const saveConfig = async () => {
    if (!normalizedDraft) return;
    setBusyAction("save");
    setSaveState("");
    try {
      const res = await fetch("/api/agent/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(normalizedDraft),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Unable to save");
      setSaveState("Saved");
      config.refresh();
    } catch (error) {
      setSaveState(`Error: ${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const saveSecrets = async () => {
    setBusyAction("secrets");
    setSaveState("");
    try {
      const res = await fetch("/api/agent/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(secretDraft),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Unable to store credentials");
      setSaveState("Stored local Boros signing credentials");
      setSecretDraft((prev) => ({ ...prev, privateKey: "" }));
      secrets.refresh();
      status.refresh();
    } catch (error) {
      setSaveState(`Error: ${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const connectAcp = async () => {
    setBusyAction("connect-acp");
    setSaveState("");
    try {
      const res = await fetch("/api/agent/connect-acp", { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Unable to start ACP authentication");
      setSaveState(json.acp?.authenticated ? "ACP already authenticated" : "ACP device authorization started");
      status.refresh();
    } catch (error) {
      setSaveState(`Error: ${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const runAction = async (pathname: string, body?: unknown) => {
    setBusyAction(pathname);
    setSaveState("");
    try {
      const res = await fetch(pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Agent action failed");
      setSaveState(pathname.endsWith("deploy") ? "Agent deployed" : "Agent updated");
      status.refresh();
      actions.refresh();
      audit.refresh();
    } catch (error) {
      setSaveState(`Error: ${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="grid gap-0.5 p-0.5 overflow-hidden flex-1 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] grid-rows-[auto_1fr]">
      <Panel
        title="Agent Control"
        meta={runtime ? `${runtime.runtimeState} | ${runtime.mode}` : "loading"}
        loading={status.loading || config.loading}
        error={status.error || config.error}
      >
        <div className="space-y-3">
          {/* ── Hero Deploy Button ── */}
          {(() => {
            const stillLoading = !runtime || !draft;
            const state = runtime?.runtimeState;
            const isRunning = state === "running";
            const isPaused = state === "paused";
            const isKillSwitched = state === "kill_switched";
            const isStopped = !state || state === "stopped" || state === "not_configured" || state === "ready" || state === "error" || isKillSwitched;
            const isDeploying = busyAction === "/api/agent/deploy";
            const isStopping = busyAction === "/api/agent/stop";
            const isPausing = busyAction === "/api/agent/pause";
            const isResuming = busyAction === "/api/agent/resume";
            // Only block if ACP is confirmed not authenticated (not just loading)
            const acpBlocked = normalizedDraft?.acpEnabled && runtime && !runtime.acp.authenticated;
            const secretsBlocked = normalizedDraft?.mode === "live" && secretStatus !== null && !secretStatus?.configured;
            const blocked = isStopped && !!(acpBlocked || secretsBlocked || !normalizedDraft);

            const handleHeroDeploy = async () => {
              if (isStopped) {
                if (isDirty && normalizedDraft) {
                  setBusyAction("/api/agent/deploy");
                  setSaveState("");
                  try {
                    const saveRes = await fetch("/api/agent/config", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(normalizedDraft),
                    });
                    const saveJson = await saveRes.json();
                    if (!saveRes.ok || !saveJson.ok) throw new Error(saveJson.error ?? "Unable to save");
                    config.refresh();
                  } catch (error) {
                    setSaveState(`Error: ${String(error)}`);
                    setBusyAction(null);
                    return;
                  }
                }
                await runAction("/api/agent/deploy", normalizedDraft ?? undefined);
              } else if (isPaused) {
                await runAction("/api/agent/resume");
              } else if (isRunning) {
                await runAction("/api/agent/pause");
              }
            };

            const bgColor = stillLoading
              ? "bg-background/40"
              : isRunning
                ? "bg-green/90 hover:bg-green"
                : isPaused
                  ? "bg-yellow-500/80 hover:bg-yellow-500"
                  : isKillSwitched
                    ? "bg-red/80 hover:bg-red"
                    : "bg-coral hover:bg-coral/80";

            const label = stillLoading
              ? "Connecting..."
              : isDeploying
                ? "Deploying..."
                : isResuming
                  ? "Resuming..."
                  : isPausing
                    ? "Pausing..."
                    : isRunning
                      ? "Agent Running — Click to Pause"
                      : isPaused
                        ? "Agent Paused — Click to Resume"
                        : isKillSwitched
                          ? "Kill Switch Active — Click to Redeploy"
                          : "Deploy Agent";

            const dotClass = isRunning
              ? "bg-white animate-pulse"
              : isPaused
                ? "bg-white/70"
                : isKillSwitched
                  ? "bg-white animate-pulse"
                  : "bg-white/50";

            return (
              <div className="space-y-2">
                <button
                  onClick={handleHeroDeploy}
                  disabled={stillLoading || busyAction !== null || blocked}
                  className={`w-full flex items-center justify-center gap-3 rounded-lg py-4 px-6 text-sm font-bold tracking-wide text-white transition-all ${bgColor} ${(stillLoading || blocked) ? "opacity-60 cursor-not-allowed" : "cursor-pointer"} ${busyAction !== null ? "opacity-70" : ""}`}
                >
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotClass}`} />
                  {label}
                </button>
                {(isRunning || isPaused) && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="flex-1 text-red hover:text-red/80"
                      onClick={() => runAction("/api/agent/stop")}
                      disabled={busyAction !== null}
                    >
                      {isStopping ? "Stopping..." : "Stop Agent"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="flex-1"
                      onClick={() => runAction("/api/agent/close-only", { closeOnly: !(runtime?.closeOnly ?? false) })}
                      disabled={busyAction !== null}
                    >
                      {runtime?.closeOnly ? "Disable Close-Only" : "Enable Close-Only"}
                    </Button>
                  </div>
                )}
                {blocked && isStopped && (
                  <div className="text-[11px] text-text-muted text-center">
                    {acpBlocked ? "Authenticate ACP first" : secretsBlocked ? "Configure live-mode credentials below" : "Loading configuration..."}
                  </div>
                )}
              </div>
            );
          })()}

          <div className="rounded border border-border/40 bg-background/20 p-3">
            <div className="text-[12px] font-semibold text-coral">Configuration</div>
            <div className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              Leave fields at defaults and the agent will decide strategy, markets, and sizing autonomously.
              You only need to set mode and safety guardrails.
            </div>
          </div>

          <div className="grid grid-cols-[1.4fr_1fr] gap-3">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-[11px] text-text-muted">
                  Mode
                  <select
                    className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                    value={draft?.mode ?? "paper"}
                    onChange={(e) => setDraft((prev) => prev ? { ...prev, mode: e.target.value as AgentConfig["mode"] } : prev)}
                  >
                    <option value="paper">paper</option>
                    <option value="live">live</option>
                  </select>
                </label>
                <label className="text-[11px] text-text-muted">
                  Max Positions
                  <input
                    className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                    type="number"
                    min={1}
                    value={draft?.maxPositions ?? 1}
                    onChange={(e) => setDraft((prev) => prev ? { ...prev, maxPositions: Number(e.target.value) } : prev)}
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-[11px] text-text-muted">
                  Max Leverage
                  <input
                    className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                    type="number"
                    step="0.1"
                    min={0.1}
                    value={draft?.leverageCap ?? 0}
                    onChange={(e) => setDraft((prev) => prev ? { ...prev, leverageCap: Number(e.target.value) } : prev)}
                  />
                </label>
                <label className="text-[11px] text-text-muted">
                  Max Daily Drawdown %
                  <input
                    className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                    type="number"
                    step="0.01"
                    min={0.01}
                    value={draft?.maxDailyDrawdownPct ?? 0}
                    onChange={(e) => setDraft((prev) => prev ? { ...prev, maxDailyDrawdownPct: Number(e.target.value) } : prev)}
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-[11px] text-text-muted">
                  Per-Market Margin %
                  <input
                    className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                    type="number"
                    step="0.01"
                    min={0.01}
                    value={draft?.maxInitialMarginPctPerMarket ?? 0}
                    onChange={(e) => setDraft((prev) => prev ? { ...prev, maxInitialMarginPctPerMarket: Number(e.target.value) } : prev)}
                  />
                </label>
                <label className="text-[11px] text-text-muted">
                  Total Margin %
                  <input
                    className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                    type="number"
                    step="0.01"
                    min={0.01}
                    value={draft?.maxTotalMarginPct ?? 0}
                    onChange={(e) => setDraft((prev) => prev ? { ...prev, maxTotalMarginPct: Number(e.target.value) } : prev)}
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={saveConfig} disabled={busyAction !== null || !isDirty}>
                  {busyAction === "save" ? "Saving..." : isDirty ? "Save Changes" : "Saved"}
                </Button>
                <Button size="sm" variant="ghost" onClick={connectAcp} disabled={busyAction !== null || Boolean(runtime?.acp.authenticated)}>
                  {busyAction === "connect-acp" ? "Authorizing..." : runtime?.acp.authenticated ? "ACP Ready" : "Authenticate ACP"}
                </Button>
              </div>

              {saveState && <div className="text-[11px] text-text-muted">{saveState}</div>}
              {runtime?.lastError && <div className="text-[11px] text-red">{runtime.lastError}</div>}
              {runtime?.acp.deviceAuth?.active && (
                <div className="rounded border border-border/40 p-3 space-y-1 text-[11px]">
                  <div className="text-text-secondary">{runtime.acp.deviceAuth.message ?? "Complete device authorization in your browser."}</div>
                  {runtime.acp.deviceAuth.verificationUri && (
                    <div className="font-mono break-all">{runtime.acp.deviceAuth.verificationUri}</div>
                  )}
                  {runtime.acp.deviceAuth.code && (
                    <div className="font-mono text-coral">Code: {runtime.acp.deviceAuth.code}</div>
                  )}
                </div>
              )}

              <details className="rounded border border-border/30 p-3">
                <summary className="cursor-pointer text-[11px] font-semibold tracking-wide text-text-muted">
                  Advanced Settings
                </summary>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-[11px] text-text-muted">
                      Confidence Threshold
                      <input
                        className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                        type="number"
                        step="0.01"
                        min={0}
                        max={1}
                        value={draft?.confidenceThreshold ?? 0}
                        onChange={(e) => setDraft((prev) => prev ? { ...prev, confidenceThreshold: Number(e.target.value) } : prev)}
                      />
                    </label>
                    <label className="text-[11px] text-text-muted">
                      Polling (ms)
                      <input
                        className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                        type="number"
                        min={5000}
                        value={draft?.pollingIntervalMs ?? 0}
                        onChange={(e) => setDraft((prev) => prev ? { ...prev, pollingIntervalMs: Number(e.target.value) } : prev)}
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-[11px] text-text-muted">
                      Margin Utilization
                      <input
                        className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                        type="number"
                        step="0.01"
                        min={0.1}
                        max={1}
                        value={draft?.marginUtilizationTargetPct ?? 0}
                        onChange={(e) => setDraft((prev) => prev ? { ...prev, marginUtilizationTargetPct: Number(e.target.value) } : prev)}
                      />
                    </label>
                    <label className="text-[11px] text-text-muted">
                      Max Collateral Transfer
                      <input
                        className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                        type="number"
                        min={0}
                        value={draft?.maxCollateralTransferUsd ?? 0}
                        onChange={(e) => setDraft((prev) => prev ? { ...prev, maxCollateralTransferUsd: Number(e.target.value) } : prev)}
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-[11px] text-text-muted">
                      Take Profit %
                      <input
                        className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                        type="number"
                        step="0.01"
                        min={0}
                        value={draft?.takeProfitPct ?? 0}
                        onChange={(e) => setDraft((prev) => prev ? { ...prev, takeProfitPct: Number(e.target.value) } : prev)}
                      />
                    </label>
                    <label className="text-[11px] text-text-muted">
                      Stop Loss %
                      <input
                        className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                        type="number"
                        step="0.01"
                        min={0}
                        value={draft?.stopLossPct ?? 0}
                        onChange={(e) => setDraft((prev) => prev ? { ...prev, stopLossPct: Number(e.target.value) } : prev)}
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-[11px] text-text-muted">
                      Trailing Arm %
                      <input
                        className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                        type="number"
                        step="0.01"
                        min={0}
                        value={draft?.trailingStopArmPct ?? 0}
                        onChange={(e) => setDraft((prev) => prev ? { ...prev, trailingStopArmPct: Number(e.target.value) } : prev)}
                      />
                    </label>
                    <label className="text-[11px] text-text-muted">
                      Trailing Giveback %
                      <input
                        className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                        type="number"
                        step="0.01"
                        min={0}
                        value={draft?.trailingStopGivebackPct ?? 0}
                        onChange={(e) => setDraft((prev) => prev ? { ...prev, trailingStopGivebackPct: Number(e.target.value) } : prev)}
                      />
                    </label>
                  </div>

                  <label className="text-[11px] text-text-muted block">
                    Market Allowlist
                    <input
                      className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                      value={draft?.marketAllowlist ?? ""}
                      onChange={(e) => setDraft((prev) => prev ? { ...prev, marketAllowlist: e.target.value } : prev)}
                      placeholder="Leave blank to let the agent choose"
                    />
                  </label>

                  <label className="text-[11px] text-text-muted block">
                    Enabled Strategies
                    <input
                      className="mt-1 w-full bg-background border border-border px-2 py-1.5 text-xs"
                      value={enabledStrategiesInput}
                      onChange={(e) => setEnabledStrategiesInput(e.target.value)}
                      placeholder="relative_value, settlement_sniper, negative_funding, cross_market"
                    />
                  </label>

                  {secretStatus && (
                    <div className="rounded border border-border/40 p-3 space-y-2">
                      <div className="text-[11px] text-text-muted">Signer Override</div>
                      <MiniRow label="Credential Source" value={secretStatus.source} />
                      <MiniRow label="RPC" value={secretStatus.rpcUrlPreview ?? "--"} />
                      <MiniRow label="Account" value={secretStatus.accountId ?? "--"} />
                      <MiniRow label="Address" value={secretStatus.rootAddressMasked ?? "--"} />
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          className="bg-background border border-border px-2 py-1.5 text-xs"
                          placeholder="RPC URL"
                          value={secretDraft.rpcUrl}
                          onChange={(e) => setSecretDraft((prev) => ({ ...prev, rpcUrl: e.target.value }))}
                        />
                        <input
                          className="bg-background border border-border px-2 py-1.5 text-xs"
                          placeholder="Account ID"
                          value={secretDraft.accountId}
                          onChange={(e) => setSecretDraft((prev) => ({ ...prev, accountId: e.target.value }))}
                        />
                        <input
                          className="bg-background border border-border px-2 py-1.5 text-xs"
                          placeholder="Root Address"
                          value={secretDraft.rootAddress}
                          onChange={(e) => setSecretDraft((prev) => ({ ...prev, rootAddress: e.target.value }))}
                        />
                        <input
                          className="bg-background border border-border px-2 py-1.5 text-xs"
                          placeholder="Private Key"
                          type="password"
                          value={secretDraft.privateKey}
                          onChange={(e) => setSecretDraft((prev) => ({ ...prev, privateKey: e.target.value }))}
                        />
                      </div>
                      <Button size="sm" onClick={saveSecrets} disabled={busyAction !== null}>
                        {busyAction === "secrets" ? "Saving Keys..." : "Save Key Override"}
                      </Button>
                    </div>
                  )}
                </div>
              </details>
            </div>

            <div className="space-y-1.5 border border-border/40 p-3 rounded">
              <MiniRow label="ACP" value={<Badge variant={runtime?.acp.authenticated ? "long" : runtime?.acp.installed ? "blue" : "short"}>{runtime?.acp.message ?? "unknown"}</Badge>} />
              <MiniRow label="Claude Fallback" value={<Badge variant={runtime?.claudeFallback ? "long" : "muted"}>{runtime?.claudeFallback ? "ready" : "no API key"}</Badge>} />
              <MiniRow label="Research" value={<Badge variant="blue">always on</Badge>} />
              <MiniRow label="Strategy" value={<Badge variant="blue">agent selected</Badge>} />
              <MiniRow label="Wallet" value={<Badge variant={secretStatus?.configured ? "long" : "short"}>{secretStatus?.message ?? "loading"}</Badge>} />
              <MiniRow label="Runtime" value={<Badge variant={runtime?.runtimeState === "running" ? "live" : runtime?.runtimeState === "paused" ? "muted" : "blue"}>{runtime?.runtimeState ?? "--"}</Badge>} />
              <MiniRow label="Managed Positions" value={openCount} />
              <MiniRow label="Equity" value={account ? fmtUsd(account.equity) : "--"} />
              <MiniRow label="Kill Switch" value={riskState?.killSwitchActive ? <span className="text-red">ACTIVE</span> : <span className="text-green">OK</span>} />
              <MiniRow label="Heartbeat" value={runtime?.process.lastHeartbeat ? new Date(runtime.process.lastHeartbeat).toLocaleTimeString() : "--"} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="Agent Research"
        meta={`${research.data?.length ?? 0} notes`}
        loading={research.loading}
        error={research.error}
        className="row-span-2"
      >
        <div className="space-y-2 overflow-auto h-full">
          {(research.data ?? []).map((note) => (
            <div key={note.id} className="border border-border/30 rounded p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-coral">{note.title}</span>
                <span className="text-[10px] text-text-muted">{new Date(note.recordedAt).toLocaleString()}</span>
              </div>
              <div className="text-xs text-text-secondary leading-relaxed">{note.summary}</div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="Recommendations"
        meta={`${recommendations.data?.length ?? 0} active`}
        loading={recommendations.loading}
        error={recommendations.error}
      >
        <div className="space-y-2 overflow-auto h-full">
          {(recommendations.data ?? []).map((item) => (
            <div key={item.id} className="border border-border/30 rounded p-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant={(item.side ?? "LONG").toLowerCase() === "short" ? "short" : "long"}>{item.side ?? "WATCH"}</Badge>
                  <span className="text-xs font-semibold text-coral">{item.marketName ?? `Market ${item.marketId ?? "?"}`}</span>
                </div>
                <span className="text-[10px] text-text-muted">{Math.round(item.confidence * 100)}%</span>
              </div>
              <div className="mt-1 text-[11px] text-text-secondary">{item.thesis}</div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-0.5 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <OnChainPositions
          positions={onChainPositions?.positions ?? null}
          markets={markets}
          loading={onChainLoading}
          lastUpdated={onChainUpdated}
          error={onChainError || onChainPositions?.error || null}
          stale={onChainStale}
        />

        <Panel
          title="Actions"
          meta={`${actions.data?.length ?? 0} records`}
          loading={actions.loading}
          error={actions.error}
        >
          <div className="space-y-2 overflow-auto h-full">
            {(actions.data ?? []).map((item) => (
              <div key={item.id} className="border border-border/30 rounded p-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-coral">{item.type}</span>
                  <Badge variant={item.status === "running" || item.status === "filled" ? "long" : item.status === "error" ? "short" : "muted"}>
                    {item.status}
                  </Badge>
                </div>
                <div className="mt-1 text-[11px] text-text-secondary">{item.summary}</div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Audit / Logs"
          meta={`${audit.data?.length ?? 0} events`}
          loading={audit.loading}
          error={audit.error}
        >
          <div className="space-y-2 overflow-auto h-full">
            {(audit.data ?? []).slice(0, 8).map((item) => (
              <div key={item.id} className="border border-border/30 rounded p-2">
                <div className="flex items-center justify-between">
                  <Badge variant={item.level === "error" ? "short" : item.level === "warn" ? "blue" : "muted"}>{item.level}</Badge>
                  <span className="text-[10px] text-text-muted">{new Date(item.recordedAt).toLocaleTimeString()}</span>
                </div>
                <div className="mt-1 text-[11px] text-text-secondary">{item.message}</div>
              </div>
            ))}
            {(logs.data ?? []).slice(0, 8).map((log, index) => (
              <div key={`${log.ts}-${index}`} className="border border-border/20 rounded p-2 bg-background/30">
                <div className="text-[10px] text-text-muted">{new Date(log.ts).toLocaleTimeString()}</div>
                <div className="mt-1 text-[11px] font-mono text-text-secondary break-all">{log.line}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
