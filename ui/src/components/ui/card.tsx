import * as React from "react";
import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "bg-surface border border-border flex flex-col overflow-hidden min-w-0",
        className
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-1.5 border-b border-border bg-card/30 shrink-0",
        className
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "text-[12px] font-semibold tracking-[1px] text-text-secondary",
        className
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex-1 overflow-auto p-1", className)} {...props} />
  );
}

export { Card, CardHeader, CardTitle, CardContent };
