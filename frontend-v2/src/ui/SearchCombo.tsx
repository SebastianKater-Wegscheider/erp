import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

function cn(...parts: Array<string | false | undefined | null>) {
  return parts.filter(Boolean).join(" ");
}

export function SearchCombo<T>({
  value,
  items,
  getId,
  getLabel,
  searchKey,
  renderItem,
  placeholder,
  disabled,
  loading,
  emptyLabel,
  onChange,
  onCreateNew,
  createLabel,
  clearLabel = "Auswahl entfernen",
  maxResults = 12,
}: {
  value: string;
  items: T[];
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  searchKey: (item: T) => string;
  renderItem?: (item: T) => ReactNode;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  emptyLabel?: string;
  onChange: (id: string) => void;
  onCreateNew?: (seed: string) => void;
  createLabel?: (seed: string) => string;
  clearLabel?: string;
  maxResults?: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selected = useMemo(() => items.find((m) => getId(m) === value) ?? null, [getId, items, value]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState<string>(() => (selected ? getLabel(selected) : ""));
  const [menuPos, setMenuPos] = useState<
    | {
        left: number;
        width: number;
        top?: number;
        bottom?: number;
        maxHeight: number;
      }
    | null
  >(null);

  useEffect(() => {
    if (!open) setQ(selected ? getLabel(selected) : "");
  }, [getLabel, open, selected]);

  useEffect(() => {
    function onPointerDown(ev: PointerEvent) {
      if (!(ev.target instanceof Node)) return;
      const root = rootRef.current;
      const menu = menuRef.current;
      if (root && root.contains(ev.target)) return;
      if (menu && menu.contains(ev.target)) return;
      setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }

    const scrollOpts = { capture: true } as const;

    function compute() {
      const el = inputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const margin = 6;

      const below = Math.max(0, window.innerHeight - rect.bottom - margin);
      const above = Math.max(0, rect.top - margin);
      const placeBelow = below >= 220 || below >= above;
      const maxHeight = Math.max(160, Math.min(320, placeBelow ? below : above));

      if (placeBelow) {
        setMenuPos({ left: rect.left, top: rect.bottom + margin, width: rect.width, maxHeight });
      } else {
        setMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + margin, width: rect.width, maxHeight });
      }
    }

    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, scrollOpts);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, scrollOpts);
    };
  }, [open]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    const all = items ?? [];
    if (!query) return all.slice(0, maxResults);
    const out: T[] = [];
    for (const item of all) {
      if (searchKey(item).includes(query)) out.push(item);
      if (out.length >= maxResults) break;
    }
    return out;
  }, [items, maxResults, q, searchKey]);

  return (
    <div ref={rootRef} className="combo">
      <input
        ref={inputRef}
        className="input"
        value={q}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (open && results.length) {
              onChange(getId(results[0]));
              setOpen(false);
            }
          }
        }}
      />

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="combo-menu"
            style={{
              position: "fixed",
              left: menuPos.left,
              width: menuPos.width,
              top: menuPos.top,
              bottom: menuPos.bottom,
            }}
          >
            <div className="combo-scroll" style={{ maxHeight: menuPos.maxHeight }}>
              {loading ? <div className="combo-empty">{emptyLabel ?? "Lade…"}</div> : null}

              {!loading && !results.length ? <div className="combo-empty">{emptyLabel ?? "Keine Treffer."}</div> : null}

              {!loading
                ? results.map((item) => {
                    const id = getId(item);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={cn("combo-item", id === value && "is-selected")}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          onChange(id);
                          setOpen(false);
                        }}
                      >
                        {renderItem ? renderItem(item) : getLabel(item)}
                      </button>
                    );
                  })
                : null}

              <div className="combo-sep" />

              <button
                type="button"
                className="combo-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                {clearLabel}
              </button>

              <button
                type="button"
                className={cn("combo-item", !onCreateNew && "is-disabled")}
                disabled={!onCreateNew}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!onCreateNew) return;
                  onCreateNew(q.trim());
                  setOpen(false);
                }}
              >
                {onCreateNew ? createLabel?.(q.trim()) ?? `Neu anlegen${q.trim() ? `: “${q.trim()}”` : ""}` : "Neu anlegen"}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

