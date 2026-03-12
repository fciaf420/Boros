import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center px-1.5 py-0 text-[10px] font-semibold tracking-wide rounded-sm",
  {
    variants: {
      variant: {
        default: "bg-text-muted/10 text-text-secondary",
        long: "bg-green/10 text-green border border-green/20",
        short: "bg-red/10 text-red border border-red/20",
        paper: "bg-amber/15 text-amber border border-amber/20",
        live: "bg-red/15 text-red border border-red/20",
        copy: "bg-coral/12 text-coral border border-coral/25",
        blue: "bg-blue/10 text-blue border border-blue/20",
        muted: "bg-text-muted/10 text-text-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
