import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";

import { DashboardPage } from "./Dashboard";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  useApi: () => ({
    request: requestMock,
    fileBlob: vi.fn(async () => {
      throw new Error("fileBlob should not be called in this test");
    }),
    download: vi.fn(async () => {
      throw new Error("download should not be called in this test");
    }),
  }),
}));

const DASHBOARD_DATA = {
  inventory_value_cents: 12_000,
  cash_balance_cents: { BANK: 45_000 },
  gross_profit_month_cents: 5_000,
  sales_revenue_30d_cents: 20_000,
  gross_profit_30d_cents: 2_000,
  sales_timeseries: [],
  revenue_by_channel_30d_cents: {},
  inventory_status_counts: {},
  inventory_aging: [],
  sales_orders_draft_count: 0,
  finalized_orders_missing_invoice_pdf_count: 0,
  inventory_draft_count: 0,
  inventory_reserved_count: 0,
  inventory_returned_count: 0,
  inventory_missing_photos_count: 0,
  inventory_missing_storage_location_count: 0,
  inventory_amazon_stale_count: 3,
  inventory_old_stock_90d_count: 0,
  negative_profit_orders_30d_count: 0,
  master_products_missing_asin_count: 0,
  amazon_inventory: {
    computed_at: "2026-02-12T12:00:00+00:00",
    in_stock_units_total: 10,
    in_stock_units_priced: 7,
    in_stock_market_gross_cents: 98_000,
    in_stock_fba_payout_cents: 77_700,
    in_stock_margin_cents: 12_300,
    in_stock_units_missing_asin: 2,
    in_stock_units_fresh: 6,
    in_stock_units_stale_or_blocked: 2,
    in_stock_units_blocked: 1,
    positive_margin_units: 5,
    negative_margin_units: 2,
    top_opportunities: [
      {
        master_product_id: "00000000-0000-0000-0000-000000000111",
        sku: "SKU-111",
        title: "Mario Kart 64",
        platform: "Nintendo 64",
        region: "EU",
        variant: "",
        units_total: 2,
        units_priced: 2,
        market_gross_cents_total: 7_800,
        fba_payout_cents_total: 5_930,
        margin_cents_total: 1_630,
        amazon_last_success_at: "2026-02-12T10:00:00+00:00",
        amazon_blocked_last: false,
        amazon_rank_overall: 1200,
        amazon_rank_specific: null,
        amazon_offers_count_total: 6,
        amazon_offers_count_used_priced_total: 3,
      },
    ],
  },
  top_products_30d: [],
  worst_products_30d: [],
};

function renderPage() {
  requestMock.mockImplementation(async (path: string) => {
    if (path === "/reports/company-dashboard") return DASHBOARD_DATA;
    throw new Error(`Unhandled request in test: ${path}`);
  });

  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

it("renders amazon intelligence card with key values and opportunities", async () => {
  renderPage();

  await screen.findByText("Amazon Intelligence");
  await screen.findByText("777,00 €");
  expect(screen.getByText("Sell Value (net)")).toBeInTheDocument();
  expect(screen.getByText("777,00 €")).toBeInTheDocument();
  expect(screen.getAllByText(/Bepreist/i).length).toBeGreaterThan(0);
  expect(screen.getByText("Top Chancen")).toBeInTheDocument();
  expect(screen.getByText("Mario Kart 64")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Amazon stale Queue/i })).toHaveAttribute(
    "href",
    "/inventory?queue=AMAZON_STALE&view=overview",
  );
});
