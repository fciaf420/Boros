import type { ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { cn } from "@/lib/utils";

interface PanelProps {
  title: string;
  meta?: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyText?: string;
  emptyHint?: string;
  error?: string | null;
  stale?: boolean;
  className?: string;
  children: ReactNode;
}

export default function Panel({ title, meta, loading, empty, emptyText, emptyHint, error, stale, className, children }: PanelProps) {
  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <span className="text-[10px] text-text-muted">
          {error ? (
            <span className="text-red">API Error</span>
          ) : stale ? (
            <span className="text-amber">Stale</span>
          ) : loading ? (
            <span className="loading-dots">loading</span>
          ) : (
            meta
          )}
        </span>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="flex items-center justify-center h-full text-red text-xs">Connection error</div>
        ) : empty && !loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-1">
            <span className="text-text-muted text-xs">{emptyText ?? "No data"}</span>
            {emptyHint && <span className="text-text-muted/60 text-[11px] max-w-[200px] text-center">{emptyHint}</span>}
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
