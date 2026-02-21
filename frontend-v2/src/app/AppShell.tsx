import { LogOut, Menu, Moon, Sun } from "lucide-react";
import { useMemo, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../auth/auth";
import { Button } from "../ui/Button";
import { getTheme, setTheme, type Theme } from "./theme";

type NavItem = { to: string; label: string };
type NavSection = { label: string; items: NavItem[] };

const NAV_TOP: NavItem[] = [
  { to: "/sourcing", label: "Sourcing" },
  { to: "/dashboard", label: "Übersicht" },
];

const NAV_SECTIONS: NavSection[] = [
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
];

function getTitle(pathname: string): string {
  const all = [...NAV_TOP, ...NAV_SECTIONS.flatMap((s) => s.items)];
  return all.find((i) => i.to === pathname)?.label ?? "ERP";
}

export function AppShell() {
  const loc = useLocation();
  const { logout } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  const title = useMemo(() => getTitle(loc.pathname), [loc.pathname]);

  return (
    <div className="shell">
      {navOpen ? <button className="nav-backdrop" aria-label="Navigation schließen" onClick={() => setNavOpen(false)} /> : null}

      <aside className="nav" data-open={navOpen ? "true" : "false"}>
        <div className="nav-brand">
          <div className="nav-mark" aria-hidden="true">
            KW
          </div>
          <div className="nav-brand-text">
            <div className="nav-brand-title">KWC ERP</div>
            <div className="nav-brand-sub">Frontend v2</div>
          </div>
        </div>

        <nav className="nav-list" aria-label="Hauptnavigation">
          <div className="nav-section">
            {NAV_TOP.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => ["nav-link", isActive ? "is-active" : ""].join(" ")}
                onClick={() => setNavOpen(false)}
              >
                {item.label}
              </NavLink>
            ))}
          </div>

          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="nav-section">
              <div className="nav-section-label">{section.label}</div>
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => ["nav-link", isActive ? "is-active" : ""].join(" ")}
                  onClick={() => setNavOpen(false)}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <Button
              variant="ghost"
              size="icon"
              className="topbar-menu"
              aria-label="Navigation öffnen"
              onClick={() => setNavOpen(true)}
            >
              <Menu size={16} />
            </Button>
            <div className="topbar-title" title={title}>
              {title}
            </div>
          </div>

          <div className="topbar-actions">
            <Button
              variant="ghost"
              size="icon"
              aria-label={theme === "dark" ? "Helles Design aktivieren" : "Dunkles Design aktivieren"}
              onClick={() => {
                const next: Theme = theme === "dark" ? "light" : "dark";
                setTheme(next);
                setThemeState(next);
              }}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </Button>

            <Button variant="ghost" size="icon" aria-label="Abmelden" onClick={() => logout()}>
              <LogOut size={16} />
            </Button>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
