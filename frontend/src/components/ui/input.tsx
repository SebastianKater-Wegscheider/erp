import * as React from "react";

import { cn } from "../../lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        // Mobile: use >=16px font-size to avoid iOS Safari input zoom; slightly taller tap target.
        "flex h-10 w-full rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] px-3 py-2 text-[16px] text-[color:var(--app-text)] shadow-[inset_0_1px_0_color-mix(in_oklab,var(--app-border)_30%,transparent),0_6px_16px_-14px_color-mix(in_oklab,var(--app-primary)_42%,transparent)] transition-colors placeholder:text-[color:var(--app-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_oklab,var(--app-primary)_34%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--app-bg)] disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:py-1 sm:text-sm",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
