import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

type InlineMessageTone = "neutral" | "error" | "info";

const INLINE_MESSAGE_TONE_CLASS: Record<InlineMessageTone, string> = {
  neutral: "border-[color:var(--app-border)] bg-[color:var(--app-surface)] text-[color:var(--app-text-muted)]",
  error: "border-rose-200 bg-[color:var(--app-danger-soft)] text-rose-900 dark:border-rose-900/60 dark:text-rose-200",
  info: "border-[color:var(--app-border)] bg-[color:var(--app-primary-soft)] text-[color:var(--app-primary-strong)]",
};

type InlineMessageProps = {
  tone?: InlineMessageTone;
  children: ReactNode;
  className?: string;
};

export function InlineMessage({ tone = "neutral", children, className }: InlineMessageProps) {
  return <div className={cn("rounded-lg border p-3 text-sm", INLINE_MESSAGE_TONE_CLASS[tone], className)}>{children}</div>;
}
