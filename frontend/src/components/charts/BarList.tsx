import { cn } from "../../lib/utils";

export type BarListItem = {
  key: string;
  label: string;
  value: number;
  valueLabel?: string;
  barClassName?: string;
};

export function BarList({
  items,
  maxValue,
  className,
  emptyLabel = "Keine Daten",
}: {
  items: BarListItem[];
  maxValue?: number;
  className?: string;
  emptyLabel?: string;
}) {
  const max = maxValue ?? Math.max(0, ...items.map((i) => i.value));

  if (!items.length) {
    return <div className={cn("text-sm text-gray-500 dark:text-gray-400", className)}>{emptyLabel}</div>;
  }

  return (
    <div className={cn("space-y-3", className)}>
      {items.map((i) => {
        const pct = max > 0 ? Math.max(0, Math.min(1, i.value / max)) : 0;
        return (
          <div key={i.key} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0 truncate text-gray-700 dark:text-gray-200">{i.label}</div>
              <div className="shrink-0 font-medium text-gray-900 dark:text-gray-100">{i.valueLabel ?? i.value}</div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
              <div
                className={cn("h-2 rounded-full bg-gray-900 dark:bg-gray-100", i.barClassName)}
                style={{ width: `${Math.round(pct * 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

