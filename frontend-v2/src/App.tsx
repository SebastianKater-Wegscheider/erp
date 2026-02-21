import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./app/AppShell";
import { LoginPage } from "./auth/LoginPage";
import { RequireAuth } from "./auth/RequireAuth";
import { DashboardPage } from "./pages/DashboardPage";
import { FBAShipmentsPage } from "./pages/FBAShipmentsPage";
import { InventoryPage } from "./pages/InventoryPage";
import { MasterProductsPage } from "./pages/MasterProductsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { PurchasesPage } from "./pages/PurchasesPage";
import { StubPage } from "./pages/StubPage";
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
          <Route path="/sales" element={<StubPage title="Verkäufe" />} />
          <Route path="/marketplace" element={<StubPage title="Marktplatz" />} />
          <Route path="/cost-allocations" element={<StubPage title="Kostenverteilung" />} />
          <Route path="/opex" element={<StubPage title="Betriebsausgaben" />} />
          <Route path="/mileage" element={<StubPage title="Fahrtenbuch" />} />
          <Route path="/vat" element={<StubPage title="Umsatzsteuer" />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
