import { useState, useEffect, useRef } from "react";
import type { OrderRow, KillEventRow, CopyTradeRow } from "../types";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";

interface ActivityLogProps {
  orders: OrderRow[] | null;
  killEvents: KillEventRow[] | null;
  copyTrades: CopyTradeRow[] | null;
  loading: boolean;
}

interface LogEntry {
  ts: number;
  type: "order" | "kill" | "copy" | "info";
  severity: "ok" | "skip" | "error";
  message: string;
}

const TYPE_CONFIG: Record<string, { label: string; variant: "blue" | "short" | "copy" | "muted" }> = {
  order: { label: "ORD", variant: "blue" },
  kill: { label: "KIL", variant: "short" },
  copy: { label: "CPY", variant: "copy" },
  info: { label: "SYS", variant: "muted" },
};

/** Classify an order as a system error vs. a normal strategy skip */
function classifyOrder(o: OrderRow): "ok" | "skip" | "error" {
  const status = o.status.toUpperCase();
  const notes = (o.notes ?? "").toLowerCase();

  // System errors: API failures, network issues, server errors
  if (status === "FAILED" || status === "ERROR") {
    if (notes.includes("api") || notes.includes("request failed") || notes.includes("timeout") ||
        notes.includes("network") || notes.includes("500") || notes.includes("502") || notes.includes("503") ||
        notes.includes("400") || notes.includes("401") || notes.includes("403") || notes.includes("429")) {
      return "error";
    }
  }

  // Strategy skips: edge too low, slippage, risk limits, no fill, etc.
  if (status === "SKIPPED" || status === "CANCELLED" || status === "REJECTED") return "skip";
  if (status === "FAILED" && (
    notes.includes("slippage") || notes.includes("edge") || notes.includes("size") ||
    notes.includes("margin") || notes.includes("liquidity") || notes.includes("risk") ||
    notes.includes("cooldown") || notes.includes("kill switch")
  )) return "skip";

  if (status === "FILLED" || status === "EXECUTED" || status === "PARTIAL") return "ok";

  return notes.includes("api") || notes.includes("request failed") ? "error" : "skip";
}

export default function ActivityLog({ orders, killEvents, copyTrades, loading }: ActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<"all" | "order" | "kill" | "copy">("all");

  const entries: LogEntry[] = [];

  if (orders) {
    for (const o of orders) {
      entries.push({
        ts: o.recorded_at,
        type: "order",
        severity: classifyOrder(o),
        message: `${o.action} ${o.side} | mkt ${o.market_id} | ${o.order_intent} | APR ${(o.order_apr * 100).toFixed(2)}% | edge ${o.net_edge_bps.toFixed(0)}bps | fill ${(o.fill_apr * 100).toFixed(2)}% | ${o.status}${o.notes ? ` | ${o.notes}` : ""}`,
      });
    }
  }

  if (killEvents) {
    for (const k of killEvents) {
      entries.push({
        ts: k.recorded_at,
        type: "kill",
        severity: "error",
        message: k.reason,
      });
    }
  }

  if (copyTrades) {
    for (const t of copyTrades) {
      const severity = t.status.toUpperCase() === "EXECUTED" ? "ok"
        : t.status.toUpperCase() === "FAILED" ? "error" : "skip";
      entries.push({
        ts: t.recorded_at,
        type: "copy",
        severity,
        message: `${t.delta_action} ${t.target_side} | mkt ${t.target_market_id} | size ${t.our_size_base.toFixed(4)} | ${t.status}${t.reason ? ` | ${t.reason}` : ""}`,
      });
    }
  }

  entries.sort((a, b) => b.ts - a.ts);

  const counts = { order: 0, kill: 0, copy: 0 };
  for (const e of entries) {
    if (e.type in counts) counts[e.type as keyof typeof counts]++;
  }

  const filtered = filter === "all" ? entries : entries.filter(e => e.type === filter);
  const display = filtered.slice(0, 100);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [orders, killEvents, copyTrades]);

  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardTitle>Activity Log</CardTitle>
          <div className="flex items-center gap-0.5">
            {(["all", "order", "kill", "copy"] as const).map((f) => {
              const label = f === "all" ? "All" : f === "order" ? "Orders" : f === "kill" ? "Kills" : "Copy";
              const count = f === "all" ? entries.length : counts[f as keyof typeof counts] ?? 0;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-1.5 py-0.5 text-[10px] font-semibold tracking-wide rounded transition-colors ${
                    filter === f
                      ? "bg-coral/20 text-coral"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {label}
                  <span className="ml-1 text-[9px] opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
        <span className="text-[10px] text-text-muted">{display.length} entries</span>
      </CardHeader>
      <CardContent>
        <div ref={scrollRef} className="h-full overflow-auto">
          {loading && display.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-muted text-xs">
              <span className="loading-dots">loading</span>
            </div>
          ) : display.length === 0 ? (
            <div className="px-2 py-1 text-xs text-text-muted">
              <Badge variant="muted">SYS</Badge>
              <span className="ml-1.5">Awaiting activity...</span>
            </div>
          ) : (
            <div className="flex flex-col">
              {display.map((e, i) => {
                const d = new Date(e.ts * 1000);
                const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
                const today = new Date();
                const isToday = d.toDateString() === today.toDateString();
                const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
                const isYesterday = d.toDateString() === yesterday.toDateString();
                const dateCtx = isToday ? "" : isYesterday ? "Y " : `${d.getMonth()+1}/${d.getDate()} `;
                const config = TYPE_CONFIG[e.type] ?? TYPE_CONFIG.info;
                const laneClass = e.severity === "error"
                  ? "border-l-2 border-l-red/40 bg-red/[0.03]"
                  : e.severity === "ok"
                    ? "border-l-2 border-l-green/30"
                    : "border-l-2 border-l-border";

                // Split pipe-delimited message into segments for structured display
                const segments = e.message.split(" | ");
                const statusColor = e.severity === "error" ? "text-red" : e.severity === "ok" ? "text-green" : "text-text-muted";

                return (
                  <div
                    className={`flex items-center gap-2 px-2 py-[3px] text-[11px] border-b border-border/20 ${laneClass}`}
                    key={`${e.ts}-${i}`}
                  >
                    <span className="text-text-muted font-mono text-[10px] shrink-0 w-[72px]">{dateCtx}{time}</span>
                    <Badge variant={config.variant} className="shrink-0">{config.label}</Badge>
                    {segments.length > 1 ? (
                      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                        <span className="font-mono text-[11px] text-coral font-semibold shrink-0">{segments[0]}</span>
                        {segments.slice(1, -1).map((seg, j) => (
                          <span key={j} className="font-mono text-[11px] text-text-muted shrink-0">{seg}</span>
                        ))}
                        <span className={`font-mono text-[11px] font-semibold shrink-0 ${statusColor}`}>{segments[segments.length - 1]}</span>
                      </div>
                    ) : (
                      <span className={`font-mono text-[11px] ${statusColor}`}>{e.message}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
