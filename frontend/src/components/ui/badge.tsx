import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-[0.01em] transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[color:var(--app-primary)] text-white",
        secondary:
          "border-transparent bg-[color:color-mix(in_oklab,var(--app-primary-soft)_74%,white)] text-[color:var(--app-primary-strong)]",
        outline: "border-[color:var(--app-border)] text-[color:var(--app-text)]",
        success: "border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-950/70 dark:text-emerald-200",
        warning: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950/70 dark:text-amber-200",
        danger: "border-transparent bg-rose-100 text-rose-900 dark:bg-rose-950/70 dark:text-rose-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
