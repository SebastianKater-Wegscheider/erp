import { ChevronDown, LogOut, Menu, Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

const NAV_PRIMARY: NavItem = { to: "/dashboard", label: "Übersicht" };
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
    ],
  },
  {
    label: "Finanzen",
    items: [
      { to: "/cost-allocations", label: "Kostenverteilung" },
      { to: "/opex", label: "Betriebsausgaben" },
      { to: "/bank", label: "Bank" },
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

  const navSections = useMemo(() => {
    if (vatEnabled) return NAV_SECTIONS;
    return NAV_SECTIONS.map((s) =>
      s.label === "Finanzen" ? { ...s, items: s.items.filter((i) => i.to !== "/vat") } : s,
    );
  }, [vatEnabled]);

  const allNavItems = useMemo(() => [NAV_PRIMARY, ...navSections.flatMap((s) => s.items)], [navSections]);
  const activeItem = useMemo(() => allNavItems.find((n) => n.to === loc.pathname), [allNavItems, loc.pathname]);
  const isActive = (to: string) => loc.pathname === to;
  const isSectionActive = (items: NavItem[]) => items.some((i) => isActive(i.to));

  useEffect(() => {
    if (!mobileNavOpen) return;
    // When opening the drawer: reset search and expand the currently active section.
    setMobileNavQuery("");
    const next: Record<string, boolean> = {};
    for (const s of navSections) next[s.label] = isSectionActive(s.items);
    setMobileOpenSections(next);
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
    <div className="sticky top-0 z-40 border-b border-gray-200 bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-950/80">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={NAV_PRIMARY.to}
            className="shrink-0 font-semibold tracking-tight text-gray-900 hover:text-gray-700 dark:text-gray-100 dark:hover:text-gray-200"
          >
            <span className="sm:hidden">KWC</span>
            <span className="hidden sm:inline">Kater-Wegscheider Company</span>
          </Link>

          {activeItem && (
            <div className="min-w-0 md:hidden">
              <div className="truncate text-sm text-gray-500 dark:text-gray-400">{activeItem.label}</div>
            </div>
          )}

          <div className="hidden h-6 w-px bg-gray-200 dark:bg-gray-800 md:block" />

          <div className="hidden items-center gap-1 md:flex">
            <Link
              to={NAV_PRIMARY.to}
              aria-current={isActive(NAV_PRIMARY.to) ? "page" : undefined}
              className={cnNavPill(isActive(NAV_PRIMARY.to))}
            >
              {NAV_PRIMARY.label}
            </Link>

            {navSections.map((section) => (
              <DropdownMenu key={section.label}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={[
                      "h-8 px-3",
                      isSectionActive(section.items)
                        ? "bg-gray-100 text-gray-900 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-800"
                        : "text-gray-700 dark:text-gray-300",
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
                          ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                          : "text-gray-700 dark:text-gray-200"
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
              className="left-0 top-0 flex h-dvh w-[88vw] max-w-[420px] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-r border-gray-200 p-0 dark:border-gray-800"
            >
              <DialogHeader className="border-b border-gray-200 px-4 py-4 pt-[calc(1rem+env(safe-area-inset-top))] dark:border-gray-800">
                <DialogTitle className="text-base sm:text-lg">Navigation</DialogTitle>
                <DialogDescription className="sr-only">Wechseln Sie zwischen den Modulen.</DialogDescription>
              </DialogHeader>

              <div className="flex flex-1 flex-col">
                <div className="flex-1 overflow-auto px-2 py-3">
                  <div className="sticky top-0 z-10 -mx-2 bg-white/95 px-2 pb-2 pt-1 backdrop-blur dark:bg-gray-950/80">
                    <div className="px-2 pb-2">
                      <Input
                        value={mobileNavQuery}
                        onChange={(e) => setMobileNavQuery(e.target.value)}
                        placeholder="Suchen…"
                        aria-label="Navigation durchsuchen"
                      />
                    </div>

                    <Link
                      to={NAV_PRIMARY.to}
                      onClick={() => setMobileNavOpen(false)}
                      className={cnMobileLink(isActive(NAV_PRIMARY.to))}
                    >
                      {NAV_PRIMARY.label}
                    </Link>
                  </div>

                  {!filteredNavSections.length && mobileNavQuery.trim() && (
                    <div className="px-3 py-6 text-sm text-gray-500 dark:text-gray-400">Keine Treffer.</div>
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
                            "text-gray-500 hover:bg-gray-50 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-200",
                          ].join(" ")}
                          onClick={() =>
                            setMobileOpenSections((prev) => ({ ...prev, [section.label]: !(prev[section.label] ?? false) }))
                          }
                          aria-expanded={isOpen}
                          disabled={forceOpen}
                        >
                          <span>{section.label}</span>
                          <ChevronDown className={["h-4 w-4 opacity-70 transition-transform", isOpen ? "rotate-180" : ""].join(" ")} />
                        </button>
                        {isOpen && (
                          <div className="mt-1 space-y-1">
                            {section.items.map((item) => (
                              <Link
                                key={item.to}
                                to={item.to}
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

                <div className="border-t border-gray-200 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] dark:border-gray-800">
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
    "rounded-md px-3 py-1.5 text-sm transition-colors",
    active
      ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-900 dark:hover:text-gray-100",
  ].join(" ");
}

function cnMobileLink(active: boolean) {
  return [
    "block rounded-md px-3 py-2.5 text-[16px] transition-colors sm:py-2 sm:text-sm",
    active
      ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
      : "text-gray-700 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-200 dark:hover:bg-gray-900 dark:hover:text-gray-100",
  ].join(" ");
}
