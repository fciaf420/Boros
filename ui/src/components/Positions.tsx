import type { PositionRow } from "../types";
import { fmtApr, fmtUsd } from "../utils/format";
import Panel from "./Panel";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";

interface PositionsProps {
  positions: PositionRow[] | null;
  loading: boolean;
  lastUpdated: number | null;
  error: string | null;
  stale: boolean;
}

export default function Positions({ positions, loading, lastUpdated, error, stale }: PositionsProps) {
  const rows = positions ?? [];
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "--";

  return (
    <Panel
      title="Open Positions"
      meta={`${rows.length} open | ${updated}`}
      loading={loading}
      empty={rows.length === 0}
      emptyText="No open positions"
      emptyHint="Bot is scanning for edge. Check signals panel for opportunities"
      error={error}
      stale={stale}
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Market</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Entry APR</TableHead>
            <TableHead>Curr APR</TableHead>
            <TableHead>Notional</TableHead>
            <TableHead>Margin</TableHead>
            <TableHead>Lev</TableHead>
            <TableHead>Unreal PnL</TableHead>
            <TableHead>Real PnL</TableHead>
            <TableHead>Liq bps</TableHead>
            <TableHead>Edge bps</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => {
            const totalRealPnl = p.realized_carry_pnl_usd + p.realized_trading_pnl_usd;
            return (
              <TableRow key={p.id}>
                <TableCell className="text-coral font-semibold">{p.market_name}</TableCell>
                <TableCell>
                  <Badge variant={p.side.toLowerCase() === "long" ? "long" : "short"}>{p.side}</Badge>
                </TableCell>
                <TableCell>{fmtApr(p.entry_apr)}</TableCell>
                <TableCell>{fmtApr(p.current_apr)}</TableCell>
                <TableCell>{fmtUsd(p.notional_usd)}</TableCell>
                <TableCell>{fmtUsd(p.initial_margin_usd)}</TableCell>
                <TableCell className="text-amber">{p.actual_leverage.toFixed(1)}x</TableCell>
                <TableCell className={p.unrealized_pnl_usd >= 0 ? "text-green" : "text-red"}>
                  {fmtUsd(p.unrealized_pnl_usd, { signed: true })}
                </TableCell>
                <TableCell className={totalRealPnl >= 0 ? "text-green" : "text-red"}>
                  {fmtUsd(totalRealPnl, { signed: true })}
                </TableCell>
                <TableCell className={
                  (p.liquidation_buffer_bps ?? 0) < 200 ? "text-red" :
                  (p.liquidation_buffer_bps ?? 0) < 400 ? "text-amber" : "text-text-muted"
                }>
                  {p.liquidation_buffer_bps?.toFixed(0) ?? "--"}
                </TableCell>
                <TableCell className="text-text-muted">{p.last_signal_edge_bps.toFixed(0)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Panel>
  );
}
