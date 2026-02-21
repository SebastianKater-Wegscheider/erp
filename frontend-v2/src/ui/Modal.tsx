import { X } from "lucide-react";
import { useEffect, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./Button";

export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onMouseDown={() => onClose()}
    >
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ minWidth: 0 }}>
            <div className="modal-title" id={titleId}>
              {title}
            </div>
            {description ? (
              <div className="modal-sub" id={descriptionId}>
                {description}
              </div>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Schließen" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>

        <div className="modal-body">{children}</div>

        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

