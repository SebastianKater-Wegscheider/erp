import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  descriptionClassName?: string;
  actionsClassName?: string;
};

export function PageHeader({ title, description, actions, className, descriptionClassName, actionsClassName }: PageHeaderProps) {
  return (
    <div className={cn("rise-in flex flex-col gap-3 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0">
        <div className="font-display text-[1.45rem] leading-[1.05] text-[color:var(--app-text)] sm:text-[1.7rem]">{title}</div>
        {description ? (
          <div className={cn("mt-1.5 text-sm text-[color:var(--app-text-muted)]", descriptionClassName)}>
            {description}
          </div>
        ) : null}
      </div>
      {actions ? <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end", actionsClassName)}>{actions}</div> : null}
    </div>
  );
}
