import { X } from "lucide-react";
import type React from "react";

import { Button } from "./Button";

export function InlineAlert({
  tone,
  children,
  onDismiss,
}: {
  tone: "info" | "error";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={["alert", tone === "error" ? "alert--error" : ""].join(" ")}>
      <div className="alert-row">
        <div className="alert-body">{children}</div>
        {onDismiss ? (
          <Button type="button" variant="ghost" size="icon" aria-label="Schließen" onClick={onDismiss}>
            <X size={16} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
