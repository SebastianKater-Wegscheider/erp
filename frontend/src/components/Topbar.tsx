import { ChevronDown, LogOut, Menu, Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { useTaxProfile } from "../lib/taxProfile";
import { getActiveTheme, type Theme, toggleTheme } from "../lib/theme";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";

type NavItem = { to: string; label: string };
type NavSection = { label: string; items: NavItem[] };

const NAV_TOP_LEVEL: NavItem[] = [
  { to: "/sourcing", label: "Sourcing" },
  { to: "/dashboard", label: "Übersicht" },
];
const NAV_SECTIONS = [
  {
    label: "Stammdaten",
    items: [
      { to: "/master-products", label: "Produktstamm" },
      { to: "/inventory", label: "Lagerbestand" },
      { to: "/fba-shipments", label: "FBA Sendungen" },
    ],
  },
  {
    label: "Belege",
    items: [
      { to: "/purchases", label: "Einkäufe" },
      { to: "/sales", label: "Verkäufe" },
      { to: "/marketplace", label: "Marktplatz" },
    ],
  },
  {
    label: "Finanzen",
    items: [
      { to: "/cost-allocations", label: "Kostenverteilung" },
      { to: "/opex", label: "Betriebsausgaben" },
      { to: "/vat", label: "Umsatzsteuer" },
      { to: "/mileage", label: "Fahrtenbuch" },
    ],
  },
] satisfies NavSection[];

export function Topbar() {
  const { clearCredentials } = useAuth();
  const taxProfile = useTaxProfile();
  const vatEnabled = taxProfile.data?.vat_enabled ?? true;
  const loc = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileNavQuery, setMobileNavQuery] = useState("");
  const [mobileOpenSections, setMobileOpenSections] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<Theme>(() => getActiveTheme());
  const mobileNavScrollRef = useRef<HTMLDivElement | null>(null);

  const navSections = useMemo(() => {
    if (vatEnabled) return NAV_SECTIONS;
    return NAV_SECTIONS.map((s) =>
      s.label === "Finanzen" ? { ...s, items: s.items.filter((i) => i.to !== "/vat") } : s,
    );
  }, [vatEnabled]);

  const allNavItems = useMemo(() => [...NAV_TOP_LEVEL, ...navSections.flatMap((s) => s.items)], [navSections]);
  const isActive = (to: string) => {
    if (to === "/sourcing") return loc.pathname === "/sourcing" || loc.pathname.startsWith("/sourcing/");
    return loc.pathname === to;
  };
  const activeItem = allNavItems.find((n) => isActive(n.to));
  const isSectionActive = (items: NavItem[]) => items.some((i) => isActive(i.to));

  useEffect(() => {
    if (!mobileNavOpen) return;
    // When opening the drawer: reset search and expand the currently active section.
    setMobileNavQuery("");
    const next: Record<string, boolean> = {};
    for (const s of navSections) next[s.label] = true;
    setMobileOpenSections(next);

    // Ensure the active route is visible even when the drawer content is long.
    // (Use double rAF so layout has settled before querying/scrolling.)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scroller = mobileNavScrollRef.current;
        if (!scroller) return;
        const el = scroller.querySelector("[aria-current='page']");
        if (el instanceof HTMLElement) el.scrollIntoView({ block: "center" });
      });
    });
  }, [mobileNavOpen, navSections, loc.pathname]);

  const filteredNavSections = useMemo(() => {
    const q = mobileNavQuery.trim().toLowerCase();
    if (!q) return navSections;
    return navSections
      .map((s) => ({
        ...s,
        items: s.items.filter((i) => i.label.toLowerCase().includes(q)),
      }))
      .filter((s) => s.items.length > 0);
  }, [navSections, mobileNavQuery]);

  return (
    <div className="sticky top-0 z-40 border-b border-[color:color-mix(in_oklab,var(--app-border)_70%,transparent)] bg-[color:color-mix(in_oklab,var(--app-surface-elevated)_92%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/dashboard"
            className="group inline-flex shrink-0 items-center gap-2 rounded-lg px-1 py-0.5 text-[color:var(--app-text)] transition-colors hover:text-[color:var(--app-primary-strong)]"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[color:var(--app-primary-soft)] text-[11px] font-bold uppercase tracking-wide text-[color:var(--app-primary-strong)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--app-primary)_22%,transparent)]">
              KW
            </span>
            <span className="font-display text-[1.02rem] leading-none sm:hidden">KWC</span>
            <span className="font-display hidden text-[1.04rem] leading-none sm:inline">Kater-Wegscheider Company</span>
          </Link>

          {activeItem && (
            <div className="min-w-0 md:hidden">
              <div className="truncate text-sm text-[color:var(--app-text-muted)]">{activeItem.label}</div>
            </div>
          )}

          <div className="hidden h-6 w-px bg-[color:var(--app-border)] md:block" />

          <div className="hidden items-center gap-1 rounded-xl border border-[color:var(--app-border)] bg-[color:color-mix(in_oklab,var(--app-surface)_84%,var(--app-primary-soft))] p-1 shadow-[inset_0_1px_2px_color-mix(in_oklab,var(--app-border)_50%,transparent)] md:flex">
            {NAV_TOP_LEVEL.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                aria-current={isActive(item.to) ? "page" : undefined}
                className={cnNavPill(isActive(item.to))}
              >
                {item.label}
              </Link>
            ))}

            {navSections.map((section) => (
              <DropdownMenu key={section.label}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={[
                      "h-8 rounded-lg px-3",
                      isSectionActive(section.items)
                        ? "bg-[color:var(--app-surface-elevated)] text-[color:var(--app-primary-strong)] shadow-[0_7px_18px_-16px_color-mix(in_oklab,var(--app-primary)_80%,transparent)]"
                        : "text-[color:var(--app-text-muted)] hover:text-[color:var(--app-text)]",
                    ].join(" ")}
                  >
                    {section.label}
                    <ChevronDown className="h-4 w-4 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {section.items.map((item) => (
                    <DropdownMenuItem
                      key={item.to}
                      asChild
                      className={
                        isActive(item.to)
                          ? "bg-[color:var(--app-primary-soft)] font-medium text-[color:var(--app-primary-strong)]"
                          : "text-[color:var(--app-text)]"
                      }
                    >
                      <Link to={item.to} aria-current={isActive(item.to) ? "page" : undefined}>
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={theme === "dark" ? "Helles Design aktivieren" : "Dunkles Design aktivieren"}
            onClick={() => setTheme(toggleTheme())}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Navigation öffnen"
            >
              <Menu className="h-4 w-4" />
            </Button>
            <DialogContent
              // Radix auto-focuses the first focusable element; with a search input first, iOS opens the keyboard.
              // Prevent that and let the user tap into search explicitly.
              onOpenAutoFocus={(e) => e.preventDefault()}
              className="left-0 top-0 flex h-dvh max-h-none w-[88vw] max-w-[420px] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-r border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] p-0"
            >
              <DialogHeader className="border-b border-[color:var(--app-border)] bg-[color:color-mix(in_oklab,var(--app-surface)_80%,var(--app-primary-soft))] px-4 py-4 pr-14 pt-[calc(1rem+env(safe-area-inset-top))]">
                <DialogTitle className="text-base sm:text-lg">Navigation</DialogTitle>
                <DialogDescription className="sr-only">Wechseln Sie zwischen den Modulen.</DialogDescription>
              </DialogHeader>

              <div className="flex min-h-0 flex-1 flex-col">
                <div ref={mobileNavScrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  <div className="sticky top-0 z-10 border-b border-[color:var(--app-border)] bg-[color:color-mix(in_oklab,var(--app-surface-elevated)_94%,transparent)] backdrop-blur">
                    <div className="px-4 pb-3 pt-2">
                      <Input
                        value={mobileNavQuery}
                        onChange={(e) => setMobileNavQuery(e.target.value)}
                        placeholder="Suchen…"
                        aria-label="Navigation durchsuchen"
                      />
                    </div>

                    <div className="px-2 pb-3">
                      <div className="space-y-1">
                        {NAV_TOP_LEVEL.map((item) => (
                          <Link
                            key={item.to}
                            to={item.to}
                            aria-current={isActive(item.to) ? "page" : undefined}
                            onClick={() => setMobileNavOpen(false)}
                            className={cnMobileLink(isActive(item.to))}
                          >
                            {item.label}
                          </Link>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="px-2 py-3">
                    {!filteredNavSections.length && mobileNavQuery.trim() && (
                      <div className="px-3 py-6 text-sm text-[color:var(--app-text-muted)]">Keine Treffer.</div>
                    )}

                    {filteredNavSections.map((section) => {
                      const open = mobileOpenSections[section.label] ?? false;
                      const forceOpen = mobileNavQuery.trim().length > 0;
                      const isOpen = forceOpen ? true : open;
                      return (
                        <div key={section.label} className="mt-3">
                          <button
                            type="button"
                            className={[
                              "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-wide",
                              "text-[color:var(--app-text-muted)] hover:bg-[color:var(--app-primary-soft)] hover:text-[color:var(--app-primary-strong)]",
                            ].join(" ")}
                            onClick={() =>
                              setMobileOpenSections((prev) => ({
                                ...prev,
                                [section.label]: !(prev[section.label] ?? false),
                              }))
                            }
                            aria-expanded={isOpen}
                            disabled={forceOpen}
                          >
                            <span>
                              {section.label}{" "}
                              <span className="font-normal opacity-70">({section.items.length})</span>
                            </span>
                            <ChevronDown
                              className={["h-4 w-4 opacity-70 transition-transform", isOpen ? "rotate-180" : ""].join(" ")}
                            />
                          </button>
                          {isOpen && (
                            <div className="mt-1 space-y-1">
                              {section.items.map((item) => (
                                <Link
                                  key={item.to}
                                  to={item.to}
                                  aria-current={isActive(item.to) ? "page" : undefined}
                                  onClick={() => setMobileNavOpen(false)}
                                  className={cnMobileLink(isActive(item.to))}
                                >
                                  {item.label}
                                </Link>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-[color:var(--app-border)] bg-[color:color-mix(in_oklab,var(--app-surface)_82%,var(--app-primary-soft))] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
                  <div className="space-y-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-center"
                      onClick={() => setTheme(toggleTheme())}
                    >
                      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                      {theme === "dark" ? "Hell" : "Dunkel"}
                    </Button>

                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full justify-center"
                      onClick={() => {
                        setMobileNavOpen(false);
                        clearCredentials();
                      }}
                    >
                      <LogOut className="h-4 w-4" />
                      Abmelden
                    </Button>
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <Button variant="secondary" className="hidden md:inline-flex" onClick={clearCredentials}>
            <LogOut className="h-4 w-4" />
            Abmelden
          </Button>
        </div>
      </div>
    </div>
  );
}

function cnNavPill(active: boolean) {
  return [
    "rounded-lg px-3 py-1.5 text-sm font-semibold transition-all",
    active
      ? "bg-[color:var(--app-surface-elevated)] text-[color:var(--app-primary-strong)] shadow-[0_7px_18px_-16px_color-mix(in_oklab,var(--app-primary)_80%,transparent)]"
      : "text-[color:var(--app-text-muted)] hover:bg-[color:var(--app-primary-soft)] hover:text-[color:var(--app-text)]",
  ].join(" ");
}

function cnMobileLink(active: boolean) {
  return [
    "block scroll-mt-24 rounded-md px-3 py-2.5 text-[16px] transition-colors sm:py-2 sm:text-sm",
    active
      ? "bg-[color:var(--app-primary-soft)] text-[color:var(--app-primary-strong)]"
      : "text-[color:var(--app-text)] hover:bg-[color:color-mix(in_oklab,var(--app-primary-soft)_55%,transparent)] hover:text-[color:var(--app-primary-strong)]",
  ].join(" ");
}
