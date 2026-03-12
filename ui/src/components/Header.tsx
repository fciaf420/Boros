import { useState, useEffect } from "react";
import type { AppState, MarketsResponse } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Settings } from "lucide-react";

interface HeaderProps {
  state: AppState | null;
  markets: MarketsResponse | null;
  onOpenSettings: () => void;
  isCopyMode: boolean;
  copyPositionCount: number;
  activeTab: "strategy" | "copy";
  onTabChange: (tab: "strategy" | "copy") => void;
  lastRefresh: number | null;
  equityUsd: number | null;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "NOW";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function Header({ state, markets, onOpenSettings, isCopyMode, copyPositionCount, activeTab, onTabChange, lastRefresh, equityUsd }: HeaderProps) {
  const mode = state?.mode ?? "paper";
  const killActive = state?.killSwitchActive ?? false;

  // Live countdown tick — updates every second
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // Find nearest settlement from markets
  let nextSettlement: number | null = null;
  if (markets?.results) {
    for (const m of markets.results) {
      const nst = m.data?.nextSettlementTime;
      if (nst && nst > now) {
        if (!nextSettlement || nst < nextSettlement) nextSettlement = nst;
      }
    }
  }

  const settlementCountdown = nextSettlement
    ? formatCountdown(nextSettlement - now)
    : "--";

  return (
    <header className="relative flex items-center gap-5 px-5 py-6 border-b border-border shrink-0 overflow-hidden">
      {/* Banner background */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-[0.55]"
        style={{ backgroundImage: "url(/banner.jpg)" }}
      />
      <div className="absolute inset-0 bg-gradient-to-r from-background/60 via-transparent to-background/60" />
      <div className="absolute inset-0 bg-gradient-to-b from-background/30 to-background/50" />

      {/* Content */}
      <div className="relative flex items-center gap-5 w-full" style={{ textShadow: "0 1px 4px rgba(0,0,0,0.7)" }}>
        <span className="text-lg font-bold tracking-[4px] text-coral drop-shadow-lg">BOROS</span>

        <div className="flex items-center gap-0.5 bg-background/60 backdrop-blur-sm rounded p-0.5">
          <button
            onClick={() => onTabChange("strategy")}
            className={`px-2.5 py-0.5 text-[11px] font-semibold tracking-wide rounded transition-colors ${
              activeTab === "strategy"
                ? "bg-coral/20 text-coral"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            Strategy
          </button>
          <button
            onClick={() => onTabChange("copy")}
            className={`px-2.5 py-0.5 text-[11px] font-semibold tracking-wide rounded transition-colors ${
              activeTab === "copy"
                ? "bg-coral/20 text-coral"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            Copy
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] tracking-wide text-text-muted">Mode</span>
          <Badge variant={mode === "live" ? "live" : "paper"}>{mode.toUpperCase()}</Badge>
          {isCopyMode && <Badge variant="copy">COPY</Badge>}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] tracking-wide text-text-muted">Kill Switch</span>
          <span className={`size-2 rounded-full ${killActive ? "bg-red" : "bg-green"}`} />
          <span className={`text-xs font-medium ${killActive ? "text-red" : "text-green"}`}>
            {killActive ? "ACTIVE" : "OK"}
          </span>
        </div>

        {equityUsd != null && equityUsd > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] tracking-wide text-text-muted">Equity</span>
            <span className="text-xs font-mono tabular-nums text-coral">
              ${equityUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </div>
        )}

        <div className="hidden md:flex items-center gap-1.5">
          <span className="text-[10px] tracking-wide text-text-muted">Markets</span>
          <span className="text-xs font-mono tabular-nums">{markets?.results?.length ?? 0}</span>
        </div>

        {isCopyMode && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] tracking-wide text-text-muted">Copy Pos</span>
            <span className="text-xs font-mono tabular-nums text-coral">{copyPositionCount}</span>
          </div>
        )}

        <div className="hidden md:flex items-center gap-1.5">
          <span className="text-[10px] tracking-wide text-text-muted">Settlement</span>
          <span className="text-xs font-mono tabular-nums text-amber">{settlementCountdown}</span>
        </div>

        <div className="hidden lg:flex items-center gap-1.5">
          <span className="text-[10px] tracking-wide text-text-muted">Last Sync</span>
          <span className="text-xs font-mono tabular-nums text-text-secondary">
            {lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "--"}
          </span>
        </div>

        <div className="flex-1" />

        <Button variant="ghost" size="icon" onClick={onOpenSettings} title="Settings">
          <Settings />
        </Button>
      </div>
    </header>
  );
}
