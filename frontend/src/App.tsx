import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AuthGate } from "./components/AuthGate";
import { Topbar } from "./components/Topbar";

const DashboardPage = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.DashboardPage })));
const MasterProductsPage = lazy(() => import("./pages/MasterProducts").then((m) => ({ default: m.MasterProductsPage })));
const InventoryPage = lazy(() => import("./pages/Inventory").then((m) => ({ default: m.InventoryPage })));
const FBAShipmentsPage = lazy(() => import("./pages/FBAShipments").then((m) => ({ default: m.FBAShipmentsPage })));
const PurchasesPage = lazy(() => import("./pages/Purchases").then((m) => ({ default: m.PurchasesPage })));
const SalesPage = lazy(() => import("./pages/Sales").then((m) => ({ default: m.SalesPage })));
const MarketplacePage = lazy(() => import("./pages/Marketplace").then((m) => ({ default: m.MarketplacePage })));
const CostAllocationsPage = lazy(() => import("./pages/CostAllocations").then((m) => ({ default: m.CostAllocationsPage })));
const OpexPage = lazy(() => import("./pages/Opex").then((m) => ({ default: m.OpexPage })));
const MileagePage = lazy(() => import("./pages/Mileage").then((m) => ({ default: m.MileagePage })));
const VatPage = lazy(() => import("./pages/Vat").then((m) => ({ default: m.VatPage })));

export function App() {
  return (
    <AuthGate>
      <div className="relative min-h-screen text-[color:var(--app-text)]">
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 top-0 z-0 h-[44vh] bg-[radial-gradient(110%_90%_at_50%_0%,color-mix(in_oklab,var(--app-primary)_14%,transparent)_0%,transparent_70%)]"
        />
        <div aria-hidden="true" className="pointer-events-none fixed left-[-12rem] top-[10rem] z-0 h-72 w-72 rounded-full bg-amber-300/20 blur-3xl dark:bg-amber-600/12" />
        <div aria-hidden="true" className="pointer-events-none fixed bottom-[-9rem] right-[-8rem] z-0 h-72 w-72 rounded-full bg-teal-400/18 blur-3xl dark:bg-teal-500/14" />

        <Topbar />
        <main className="relative z-10 mx-auto w-full max-w-[1240px] px-3 pb-8 pt-4 sm:px-4 sm:pb-10 sm:pt-6">
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/master-products" element={<MasterProductsPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/fba-shipments" element={<FBAShipmentsPage />} />
              <Route path="/purchases" element={<PurchasesPage />} />
              <Route path="/sales" element={<SalesPage />} />
              <Route path="/marketplace" element={<MarketplacePage />} />
              <Route path="/cost-allocations" element={<CostAllocationsPage />} />
              <Route path="/opex" element={<OpexPage />} />
              <Route path="/mileage" element={<MileagePage />} />
              <Route path="/vat" element={<VatPage />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </AuthGate>
  );
}

function PageFallback() {
  return (
    <div className="surface-panel rise-in rounded-xl p-4 text-sm text-[color:var(--app-text-muted)]">
      Seite wird geladen…
    </div>
  );
}
