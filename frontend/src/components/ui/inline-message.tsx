import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

type InlineMessageTone = "neutral" | "error" | "info";

const INLINE_MESSAGE_TONE_CLASS: Record<InlineMessageTone, string> = {
  neutral: "border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300",
  error: "border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200",
  info: "border-gray-200 bg-gray-50 text-gray-800 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-100",
};

type InlineMessageProps = {
  tone?: InlineMessageTone;
  children: ReactNode;
  className?: string;
};

export function InlineMessage({ tone = "neutral", children, className }: InlineMessageProps) {
  return <div className={cn("rounded-md border p-3 text-sm", INLINE_MESSAGE_TONE_CLASS[tone], className)}>{children}</div>;
}
