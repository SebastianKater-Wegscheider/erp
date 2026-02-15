import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";

import { InventoryPage } from "./Inventory";

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

const MASTER_PRODUCTS = [
  {
    id: "00000000-0000-0000-0000-000000000111",
    sku: "SKU-111",
    kind: "GAME",
    title: "Mario Kart 64",
    platform: "Nintendo 64",
    region: "EU",
    variant: "",
    asin: "B000TEST11",
    amazon_rank_specific: 400,
    amazon_offers_count_used_priced_total: 1,
    amazon_last_success_at: "2026-02-11T00:00:00.000Z",
    amazon_price_used_good_cents: 4299,
  },
];

const INVENTORY = [
  {
    id: "00000000-0000-0000-0000-000000009999",
    item_code: "IT-000000000999",
    master_product_id: "00000000-0000-0000-0000-000000000111",
    condition: "GOOD",
    purchase_type: "DIFF",
    purchase_price_cents: 2000,
    allocated_costs_cents: 0,
    storage_location: null,
    serial_number: null,
    status: "AVAILABLE",
    acquired_date: "2026-02-01",
  },
];

const FEE_PROFILE = { referral_fee_bp: 1500, fulfillment_fee_cents: 350, inbound_shipping_cents: 0 };

function renderPage(initialEntry: string) {
  requestMock.mockImplementation(async (path: string) => {
    if (path === "/master-products") return MASTER_PRODUCTS;
    if (path === "/amazon-scrapes/fee-profile") return FEE_PROFILE;
    if (path.startsWith("/inventory/images?")) return [];
    if (path.startsWith("/inventory?")) return INVENTORY;
    if (path.endsWith("/images")) return [];
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
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/inventory" element={<InventoryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
  localStorage.clear();
});

it("defaults to Priorisieren and shows KPI columns without inline IDs", async () => {
  renderPage("/inventory");

  await screen.findAllByText("Mario Kart 64");
  expect(screen.getAllByText("Marktpreis").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Abverkauf").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Marge").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Offers 1").length).toBeGreaterThan(0);
  expect(screen.queryAllByText(/^ID:/)).toHaveLength(0);
});

it("switches to Pflege mode and hides KPI labels", async () => {
  renderPage("/inventory");

  await screen.findAllByText("Mario Kart 64");
  fireEvent.click(screen.getByRole("button", { name: "Pflege" }));

  expect(await screen.findAllByText("Kosten (EUR)")).not.toHaveLength(0);
  expect(screen.queryAllByText("Marktpreis")).toHaveLength(0);
  expect(screen.queryAllByText("Abverkauf")).toHaveLength(0);
  expect(screen.queryAllByText("Marge")).toHaveLength(0);
  expect(screen.queryAllByText(/^ID:/)).toHaveLength(0);
});

it("applies queue and view from URL for deep links", async () => {
  renderPage("/inventory?queue=PHOTOS_MISSING&view=ops");

  await screen.findAllByText("Mario Kart 64");
  expect(screen.getByRole("button", { name: "Pflege" })).toBeInTheDocument();
  const inventoryCalls = requestMock.mock.calls
    .map(([path]) => path)
    .filter((path): path is string => typeof path === "string" && path.startsWith("/inventory?"));
  expect(inventoryCalls.some((path) => path.includes("queue=PHOTOS_MISSING"))).toBe(true);
});
