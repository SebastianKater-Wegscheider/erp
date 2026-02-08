import { Navigate, Route, Routes } from "react-router-dom";

import { AuthGate } from "./components/AuthGate";
import { Topbar } from "./components/Topbar";
import { DashboardPage } from "./pages/Dashboard";
import { MasterProductsPage } from "./pages/MasterProducts";
import { InventoryPage } from "./pages/Inventory";
import { FBAShipmentsPage } from "./pages/FBAShipments";
import { PurchasesPage } from "./pages/Purchases";
import { SalesPage } from "./pages/Sales";
import { CostAllocationsPage } from "./pages/CostAllocations";
import { OpexPage } from "./pages/Opex";
import { MileagePage } from "./pages/Mileage";
import { VatPage } from "./pages/Vat";
import { BankPage } from "./pages/Bank";

export function App() {
  return (
    <AuthGate>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <Topbar />
        <div className="mx-auto max-w-6xl px-4 py-6">
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
        </div>
      </div>
    </AuthGate>
  );
}
