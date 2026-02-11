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
    <div className={cn("flex flex-col gap-3 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0">
        <div className="text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">{title}</div>
        {description ? <div className={cn("mt-0.5 text-sm text-gray-500 dark:text-gray-400", descriptionClassName)}>{description}</div> : null}
      </div>
      {actions ? <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-center", actionsClassName)}>{actions}</div> : null}
    </div>
  );
}
