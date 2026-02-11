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
const CostAllocationsPage = lazy(() => import("./pages/CostAllocations").then((m) => ({ default: m.CostAllocationsPage })));
const OpexPage = lazy(() => import("./pages/Opex").then((m) => ({ default: m.OpexPage })));
const MileagePage = lazy(() => import("./pages/Mileage").then((m) => ({ default: m.MileagePage })));
const VatPage = lazy(() => import("./pages/Vat").then((m) => ({ default: m.VatPage })));
const BankPage = lazy(() => import("./pages/Bank").then((m) => ({ default: m.BankPage })));

export function App() {
  return (
    <AuthGate>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <Topbar />
        <div className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/master-products" element={<MasterProductsPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/fba-shipments" element={<FBAShipmentsPage />} />
              <Route path="/purchases" element={<PurchasesPage />} />
              <Route path="/sales" element={<SalesPage />} />
              <Route path="/cost-allocations" element={<CostAllocationsPage />} />
              <Route path="/opex" element={<OpexPage />} />
              <Route path="/mileage" element={<MileagePage />} />
              <Route path="/vat" element={<VatPage />} />
              <Route path="/bank" element={<BankPage />} />
            </Routes>
          </Suspense>
        </div>
      </div>
    </AuthGate>
  );
}

function PageFallback() {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-600 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
      Seite wird geladen…
    </div>
  );
}
