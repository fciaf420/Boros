import type { CopyTradeRow } from "../types";
import { fmtTime } from "../utils/format";
import Panel from "./Panel";
import { Badge } from "./ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./ui/table";

interface CopyTradesProps {
  trades: CopyTradeRow[] | null;
  loading: boolean;
  lastUpdated: number | null;
  error: string | null;
  stale: boolean;
}

const STATUS_CLASS: Record<string, string> = {
  EXECUTED: "text-green",
  SKIPPED: "text-amber",
  FAILED: "text-red",
};

const ACTION_CLASS: Record<string, string> = {
  ENTER: "text-green",
  EXIT: "text-red",
  INCREASE: "text-blue",
  DECREASE: "text-amber",
};

export default function CopyTrades({ trades, loading, lastUpdated, error, stale }: CopyTradesProps) {
  const rows = trades ?? [];
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "--";

  return (
    <Panel
      title="Copy Trade Log"
      meta={`${rows.length} records | ${updated}`}
      loading={loading}
      empty={rows.length === 0}
      emptyText="NO COPY TRADES"
      error={error}
      stale={stale}
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Time</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Market</TableHead>
            <TableHead>Side</TableHead>
            <TableHead>Our Size</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="text-text-muted">{fmtTime(t.recorded_at)}</TableCell>
              <TableCell className={ACTION_CLASS[t.delta_action] ?? ""}>{t.delta_action}</TableCell>
              <TableCell className="text-coral font-semibold">{t.target_market_id}</TableCell>
              <TableCell>
                <Badge variant={t.target_side.toLowerCase() === "long" ? "long" : "short"}>{t.target_side}</Badge>
              </TableCell>
              <TableCell>{t.our_size_base.toFixed(4)}</TableCell>
              <TableCell className={STATUS_CLASS[t.status] ?? ""}>{t.status}</TableCell>
              <TableCell className="text-text-muted max-w-[200px] truncate">
                {t.reason ?? "--"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
