import { LogOut } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { Button } from "./ui/button";

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/master-products", label: "Master Products" },
  { to: "/inventory", label: "Inventory" },
  { to: "/purchases", label: "Purchases" },
  { to: "/sales", label: "Sales" },
  { to: "/cost-allocations", label: "Cost Allocation" },
  { to: "/opex", label: "OpEx" },
  { to: "/mileage", label: "Mileage" },
  { to: "/vat", label: "VAT" },
];

export function Topbar() {
  const { clearCredentials } = useAuth();
  const loc = useLocation();

  return (
    <div className="sticky top-0 z-40 border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="font-semibold tracking-tight">Reseller ERP</div>
          <div className="hidden items-center gap-1 md:flex">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className={[
                  "rounded-md px-3 py-1.5 text-sm",
                  loc.pathname === n.to ? "bg-gray-100 text-gray-900" : "text-gray-600 hover:bg-gray-50",
                ].join(" ")}
              >
                {n.label}
              </Link>
            ))}
          </div>
        </div>
        <Button variant="secondary" onClick={clearCredentials}>
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
      </div>
    </div>
  );
}
