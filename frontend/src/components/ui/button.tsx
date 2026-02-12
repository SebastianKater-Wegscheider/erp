import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold tracking-[0.01em] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_oklab,var(--app-primary)_38%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--app-bg)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[color:var(--app-primary)] text-white shadow-[0_12px_22px_-16px_color-mix(in_oklab,var(--app-primary)_82%,transparent)] hover:bg-[color:var(--app-primary-strong)] hover:shadow-[0_14px_24px_-14px_color-mix(in_oklab,var(--app-primary)_82%,transparent)] active:translate-y-px",
        secondary:
          "bg-[color:var(--app-primary-soft)] text-[color:var(--app-primary-strong)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--app-primary)_24%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--app-primary-soft)_76%,white)]",
        outline:
          "border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] text-[color:var(--app-text)] shadow-[0_2px_10px_-9px_color-mix(in_oklab,var(--app-primary)_45%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--app-surface)_86%,var(--app-primary-soft))]",
        destructive:
          "bg-rose-600 text-white shadow-[0_10px_20px_-14px_rgba(190,24,93,0.85)] hover:bg-rose-700 active:translate-y-px dark:bg-rose-500 dark:hover:bg-rose-400",
        ghost:
          "text-[color:var(--app-text-muted)] hover:bg-[color:color-mix(in_oklab,var(--app-primary-soft)_44%,transparent)] hover:text-[color:var(--app-text)]",
      },
      size: {
        // Mobile: slightly larger tap targets; desktop remains unchanged via `sm:` overrides.
        default: "h-10 px-4 py-2 sm:h-9",
        sm: "h-9 rounded-md px-3 sm:h-8",
        lg: "h-10 rounded-md px-6",
        icon: "h-10 w-10 sm:h-9 sm:w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
