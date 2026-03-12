import { useMemo } from "react";
import type { SignalRow, MarketsResponse } from "../types";
import { fmtApr, fmtTime } from "../utils/format";
import Panel from "./Panel";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";

interface EdgeScannerProps {
  signals: SignalRow[] | null;
  loading: boolean;
  lastUpdated: number | null;
  error: string | null;
  stale: boolean;
  markets?: MarketsResponse | null;
}

export default function EdgeScanner({ signals, loading, lastUpdated, error, stale, markets }: EdgeScannerProps) {
  const rows = signals ?? [];
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "--";

  const marketNames = useMemo(() => {
    const map = new Map<number, string>();
    if (markets?.results) {
      for (const m of markets.results) {
        const name = m.metadata?.assetSymbol || m.imData?.symbol || String(m.marketId);
        map.set(m.marketId, name);
      }
    }
    return map;
  }, [markets]);

  return (
    <Panel
      title="Edge Scanner"
      meta={`${rows.length} signals | ${updated}`}
      loading={loading}
      empty={rows.length === 0}
      emptyText="No signals yet"
      emptyHint="Bot hasn't completed a scan cycle. Signals appear after first evaluation"
      error={error}
      stale={stale}
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Time</TableHead>
            <TableHead>Market</TableHead>
            <TableHead>Fair APR</TableHead>
            <TableHead>Edge Long</TableHead>
            <TableHead>Edge Short</TableHead>
            <TableHead>Best Side</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
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

            const marketName = marketNames.get(s.market_id) ?? String(s.market_id);

            return (
              <TableRow key={s.id}>
                <TableCell className="text-text-muted">{fmtTime(s.recorded_at)}</TableCell>
                <TableCell className="text-coral font-semibold">{marketName}</TableCell>
                <TableCell>{fmtApr(s.fair_apr)}</TableCell>
                <TableCell className={s.edge_bps_long > 100 ? "text-green" : "text-text-muted"}>
                  {s.edge_bps_long.toFixed(1)}
                </TableCell>
                <TableCell className={s.edge_bps_short > 100 ? "text-green" : "text-text-muted"}>
                  {s.edge_bps_short.toFixed(1)}
                </TableCell>
                <TableCell>
                  <Badge variant={bestSide === "LONG" ? "long" : "short"}>{bestSide}</Badge>
                  <span className="text-text-muted ml-1.5">
                    {bestEdge.toFixed(0)}bps
                  </span>
                </TableCell>
                <TableCell className={candidateAction !== "--" ? "text-amber" : "text-text-muted"}>
                  {candidateAction}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Panel>
  );
}
