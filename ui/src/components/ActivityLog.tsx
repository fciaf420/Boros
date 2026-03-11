import { useEffect, useRef } from "react";
import type { OrderRow, KillEventRow } from "../types";

interface ActivityLogProps {
  orders: OrderRow[] | null;
  killEvents: KillEventRow[] | null;
  loading: boolean;
}

interface LogEntry {
  ts: number;
  type: "order" | "kill" | "info";
  message: string;
}

export default function ActivityLog({ orders, killEvents, loading }: ActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const entries: LogEntry[] = [];

  if (orders) {
    for (const o of orders) {
      entries.push({
        ts: o.recorded_at,
        type: "order",
        message: `${o.action} ${o.side} mkt=${o.market_id} intent=${o.order_intent} apr=${(o.order_apr * 100).toFixed(2)}% edge=${o.net_edge_bps.toFixed(0)}bps fill=${(o.fill_apr * 100).toFixed(2)}% status=${o.status}${o.notes ? ` [${o.notes}]` : ""}`,
      });
    }
  }

  if (killEvents) {
    for (const k of killEvents) {
      entries.push({
        ts: k.recorded_at,
        type: "kill",
        message: `KILL SWITCH: ${k.reason}`,
      });
    }
  }

  // Sort descending (newest first)
  entries.sort((a, b) => b.ts - a.ts);
  const display = entries.slice(0, 100);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [display.length]);

  return (
    <div className="panel panel--log">
      <div className="panel__header">
        <span className="panel__title">Activity Log</span>
        <span className="panel__meta">{display.length} entries</span>
      </div>
      <div className="panel__body" ref={scrollRef}>
        {loading && display.length === 0 ? (
          <div className="empty-state"><span className="loading-dots">loading</span></div>
        ) : display.length === 0 ? (
          <div className="log-line">
            <span className="log-line__type log-line__type--info">SYS</span>
            Awaiting activity...
            <span className="log-cursor" />
          </div>
        ) : (
          <>
            {display.map((e, i) => {
              const time = new Date(e.ts * 1000).toLocaleTimeString();
              const typeClass = `log-line__type log-line__type--${e.type}`;
              const typeLabel = e.type === "order" ? "ORD" : e.type === "kill" ? "KIL" : "SYS";
              return (
                <div className="log-line" key={`${e.ts}-${i}`}>
                  <span className="log-line__ts">{time}</span>
                  <span className={typeClass}>[{typeLabel}]</span>
                  {e.message}
                </div>
              );
            })}
            <div className="log-line">
              <span className="log-cursor" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
