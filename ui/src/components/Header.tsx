import type { AppState, MarketsResponse } from "../types";

interface HeaderProps {
  state: AppState | null;
  markets: MarketsResponse | null;
  onOpenSettings: () => void;
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

export default function Header({ state, markets, onOpenSettings }: HeaderProps) {
  const mode = state?.mode ?? "paper";
  const killActive = state?.killSwitchActive ?? false;

  // Find nearest settlement from markets
  let nextSettlement: number | null = null;
  if (markets?.results) {
    const now = Math.floor(Date.now() / 1000);
    for (const m of markets.results) {
      const nst = m.data?.nextSettlementTime;
      if (nst && nst > now) {
        if (!nextSettlement || nst < nextSettlement) nextSettlement = nst;
      }
    }
  }

  const settlementCountdown = nextSettlement
    ? formatCountdown(nextSettlement - Math.floor(Date.now() / 1000))
    : "--";

  const openPositionCount = markets?.results
    ? markets.results.filter((m) => m.state === "active").length
    : 0;

  const equity = state?.runtimeState?.risk_state as { equityUsd?: number } | undefined;

  return (
    <div className="header">
      <div className="header__logo">BOROS</div>

      <div className="header__item">
        <span className="header__label">Mode</span>
        <span className={`badge badge--${mode}`}>{mode.toUpperCase()}</span>
      </div>

      <div className="header__item">
        <span className="header__label">Kill Switch</span>
        <span className={`status-dot ${killActive ? "status-dot--danger" : "status-dot--ok"}`} />
        <span className={killActive ? "val-neg" : "val-pos"}>
          {killActive ? "ACTIVE" : "OK"}
        </span>
      </div>

      {equity?.equityUsd !== undefined && (
        <div className="header__item">
          <span className="header__label">Equity</span>
          <span className="val-cyan">${equity.equityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
      )}

      <div className="header__item">
        <span className="header__label">Markets</span>
        <span>{markets?.results?.length ?? 0}</span>
      </div>

      <div className="header__item">
        <span className="header__label">Next Settlement</span>
        <span className="val-amber">{settlementCountdown}</span>
      </div>

      <div className="header__spacer" />

      <div className="header__item">
        <span className="header__label">Active Markets</span>
        <span>{openPositionCount}</span>
      </div>

      <button className="gear-btn" onClick={onOpenSettings} title="Settings">
        &#9881;
      </button>
    </div>
  );
}
