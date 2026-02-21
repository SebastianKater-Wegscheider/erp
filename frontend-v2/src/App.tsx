import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./app/AppShell";
import { LoginPage } from "./auth/LoginPage";
import { RequireAuth } from "./auth/RequireAuth";
import { DashboardPage } from "./pages/DashboardPage";
import { FBAShipmentsPage } from "./pages/FBAShipmentsPage";
import { InventoryPage } from "./pages/InventoryPage";
import { MasterProductsPage } from "./pages/MasterProductsPage";
import { MarketplacePage } from "./pages/MarketplacePage";
import { MileagePage } from "./pages/MileagePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OpexPage } from "./pages/OpexPage";
import { PurchasesPage } from "./pages/PurchasesPage";
import { SalesPage } from "./pages/SalesPage";
import { VatPage } from "./pages/VatPage";
import { CostAllocationsPage } from "./pages/CostAllocationsPage";
import { SourcingAgentsPage } from "./pages/sourcing/SourcingAgentsPage";
import { SourcingDetailPage } from "./pages/sourcing/SourcingDetailPage";
import { SourcingPage } from "./pages/sourcing/SourcingPage";
import { SourcingSettingsPage } from "./pages/sourcing/SourcingSettingsPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/inventory" element={<InventoryPage />} />

          <Route path="/sourcing" element={<SourcingPage />} />
          <Route path="/sourcing/:id" element={<SourcingDetailPage />} />
          <Route path="/sourcing/settings" element={<SourcingSettingsPage />} />
          <Route path="/sourcing/agents" element={<SourcingAgentsPage />} />
          <Route path="/master-products" element={<MasterProductsPage />} />
          <Route path="/fba-shipments" element={<FBAShipmentsPage />} />
          <Route path="/purchases" element={<PurchasesPage />} />
          <Route path="/sales" element={<SalesPage />} />
          <Route path="/marketplace" element={<MarketplacePage />} />
          <Route path="/cost-allocations" element={<CostAllocationsPage />} />
          <Route path="/opex" element={<OpexPage />} />
          <Route path="/mileage" element={<MileagePage />} />
          <Route path="/vat" element={<VatPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
