import { Search, X } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Input } from "./input";

type SearchFieldProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  className?: string;
  inputClassName?: string;
  clearAriaLabel?: string;
  disabled?: boolean;
};

export function SearchField({
  value,
  onValueChange,
  placeholder,
  className,
  inputClassName,
  clearAriaLabel = "Suche löschen",
  disabled = false,
}: SearchFieldProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
        <Input
          placeholder={placeholder}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={cn("pl-9", inputClassName)}
          disabled={disabled}
        />
      </div>
      {value.trim() ? (
        <Button type="button" variant="ghost" size="icon" onClick={() => onValueChange("")} aria-label={clearAriaLabel} disabled={disabled}>
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}
