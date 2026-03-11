import type { PositionRow } from "../types";

interface PositionsProps {
  positions: PositionRow[] | null;
  loading: boolean;
  lastUpdated: number | null;
}

function fmtApr(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

function fmtUsd(v: number): string {
  const prefix = v >= 0 ? "+$" : "-$";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return prefix + (abs / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return prefix + (abs / 1_000).toFixed(1) + "K";
  return prefix + abs.toFixed(2);
}

function fmtUsdPlain(v: number): string {
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

export default function Positions({ positions, loading, lastUpdated }: PositionsProps) {
  const rows = positions ?? [];
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "--";

  return (
    <div className="panel">
      <div className="panel__header">
        <span className="panel__title">Open Positions</span>
        <span className="panel__meta">
          {loading ? <span className="loading-dots">loading</span> : `${rows.length} open | ${updated}`}
        </span>
      </div>
      <div className="panel__body">
        {rows.length === 0 && !loading ? (
          <div className="empty-state">NO OPEN POSITIONS</div>
        ) : (
          <table className="t-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th>Entry APR</th>
                <th>Curr APR</th>
                <th>Notional</th>
                <th>Margin</th>
                <th>Lev</th>
                <th>Unreal PnL</th>
                <th>Real PnL</th>
                <th>Liq bps</th>
                <th>Edge bps</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const totalRealPnl = p.realized_carry_pnl_usd + p.realized_trading_pnl_usd;
                return (
                  <tr key={p.id}>
                    <td className="val-cyan">{p.market_name}</td>
                    <td>
                      <span className={`badge badge--${p.side.toLowerCase()}`}>{p.side}</span>
                    </td>
                    <td>{fmtApr(p.entry_apr)}</td>
                    <td>{fmtApr(p.current_apr)}</td>
                    <td>{fmtUsdPlain(p.notional_usd)}</td>
                    <td>{fmtUsdPlain(p.initial_margin_usd)}</td>
                    <td className="val-amber">{p.actual_leverage.toFixed(1)}x</td>
                    <td className={p.unrealized_pnl_usd >= 0 ? "val-pos" : "val-neg"}>
                      {fmtUsd(p.unrealized_pnl_usd)}
                    </td>
                    <td className={totalRealPnl >= 0 ? "val-pos" : "val-neg"}>
                      {fmtUsd(totalRealPnl)}
                    </td>
                    <td className={
                      (p.liquidation_buffer_bps ?? 0) < 200 ? "val-neg" :
                      (p.liquidation_buffer_bps ?? 0) < 400 ? "val-amber" : "val-neutral"
                    }>
                      {p.liquidation_buffer_bps?.toFixed(0) ?? "--"}
                    </td>
                    <td className="val-neutral">{p.last_signal_edge_bps.toFixed(0)}</td>
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
