import type { SignalRow } from "../types";

interface EdgeScannerProps {
  signals: SignalRow[] | null;
  loading: boolean;
  lastUpdated: number | null;
}

function fmtApr(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

export default function EdgeScanner({ signals, loading, lastUpdated }: EdgeScannerProps) {
  const rows = signals ?? [];
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "--";

  return (
    <div className="panel">
      <div className="panel__header">
        <span className="panel__title">Edge Scanner</span>
        <span className="panel__meta">
          {loading ? <span className="loading-dots">loading</span> : `${rows.length} signals | ${updated}`}
        </span>
      </div>
      <div className="panel__body">
        {rows.length === 0 && !loading ? (
          <div className="empty-state">NO SIGNALS</div>
        ) : (
          <table className="t-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Market</th>
                <th>Fair APR</th>
                <th>Edge Long</th>
                <th>Edge Short</th>
                <th>Best Side</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const bestSide = Math.abs(s.edge_bps_long) > Math.abs(s.edge_bps_short) ? "LONG" : "SHORT";
                const bestEdge = bestSide === "LONG" ? s.edge_bps_long : s.edge_bps_short;

                let candidateAction = "--";
                if (s.candidate_json) {
                  try {
                    const c = JSON.parse(s.candidate_json);
                    candidateAction = `${c.side ?? ""} ${c.action ?? ""}`.trim();
                  } catch { /* empty */ }
                }

                const ts = new Date(s.recorded_at * 1000).toLocaleTimeString();

                return (
                  <tr key={s.id}>
                    <td className="val-neutral">{ts}</td>
                    <td className="val-cyan">{s.market_id}</td>
                    <td>{fmtApr(s.fair_apr)}</td>
                    <td className={s.edge_bps_long > 100 ? "val-pos" : "val-neutral"}>
                      {s.edge_bps_long.toFixed(1)}
                    </td>
                    <td className={s.edge_bps_short > 100 ? "val-pos" : "val-neutral"}>
                      {s.edge_bps_short.toFixed(1)}
                    </td>
                    <td>
                      <span className={`badge badge--${bestSide.toLowerCase()}`}>{bestSide}</span>
                      <span className="val-neutral" style={{ marginLeft: 6 }}>
                        {bestEdge.toFixed(0)}bps
                      </span>
                    </td>
                    <td className={candidateAction !== "--" ? "val-amber" : "val-neutral"}>
                      {candidateAction}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
