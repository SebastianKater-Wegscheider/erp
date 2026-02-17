import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const ITEM_ID = "00000000-0000-0000-0000-000000009999";
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
    amazon_price_used_good_cents: 4_299,
  },
];

const INVENTORY = [
  {
    id: ITEM_ID,
    item_code: "IT-000000000999",
    master_product_id: "00000000-0000-0000-0000-000000000111",
    condition: "GOOD",
    purchase_type: "DIFF",
    purchase_price_cents: 2_000,
    allocated_costs_cents: 0,
    storage_location: null,
    serial_number: null,
    status: "AVAILABLE",
    acquired_date: "2026-02-01",
    target_price_mode: "AUTO",
    manual_target_sell_price_cents: null,
    recommended_target_sell_price_cents: 3_940,
    effective_target_sell_price_cents: 3_940,
    effective_target_price_source: "AUTO_AMAZON",
    target_price_recommendation: {
      strategy: "MARGIN_FIRST",
      recommended_target_sell_price_cents: 3_940,
      anchor_price_cents: 3_900,
      anchor_source: "AMAZON_CONDITION",
      adjustment_bp: 100,
      margin_floor_price_cents: 2_200,
      summary: "Anker 3900¢ (AMAZON_CONDITION) | Adj +100bp | Floor 2200¢ (Marge 500¢) | → 3940¢",
    },
  },
];

const BULK_PREVIEW = {
  matched_count: 1,
  applicable_count: 1,
  truncated: false,
  rows: [
    {
      item_id: ITEM_ID,
      item_code: "IT-000000000999",
      title: "Mario Kart 64",
      condition: "GOOD",
      asin: "B000TEST11",
      rank: 400,
      offers_count: 1,
      before_target_price_mode: "AUTO",
      before_effective_target_sell_price_cents: 3_940,
      before_effective_target_price_source: "AUTO_AMAZON",
      after_target_price_mode: "MANUAL",
      after_effective_target_sell_price_cents: 3_940,
      after_effective_target_price_source: "MANUAL",
      delta_cents: 0,
    },
  ],
};

const BULK_APPLY = {
  matched_count: 1,
  updated_count: 1,
  skipped_count: 0,
  sample_updated_item_ids: [ITEM_ID],
};

const FEE_PROFILE = { referral_fee_bp: 1500, fulfillment_fee_cents: 350, inbound_shipping_cents: 0 };

function renderPage(initialEntry = "/inventory") {
  requestMock.mockImplementation(async (path: string, options?: { method?: string; json?: unknown }) => {
    if (path === "/master-products") return MASTER_PRODUCTS;
    if (path === "/amazon-scrapes/fee-profile") return FEE_PROFILE;
    if (path.startsWith("/inventory/images?")) return [];
    if (path.startsWith("/inventory?")) return INVENTORY;
    if (path.endsWith("/images")) return [];
    if (path === "/inventory/target-pricing/preview" && options?.method === "POST") return BULK_PREVIEW;
    if (path === "/inventory/target-pricing/apply" && options?.method === "POST") return BULK_APPLY;
    if (path === `/inventory/${ITEM_ID}` && options?.method === "PATCH") {
      return { ...INVENTORY[0], ...(options?.json as object) };
    }
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

it("renders effective and recommended target pricing", async () => {
  renderPage();

  await screen.findAllByText("Mario Kart 64");
  expect(screen.getAllByText("Zielpreis").length).toBeGreaterThan(0);
  expect(screen.getAllByText("39,40 €").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Auto (Amazon)").length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Anker 3900¢/i).length).toBeGreaterThan(0);
});

it("submits row-level manual override payload", async () => {
  renderPage();

  await screen.findAllByText("Mario Kart 64");
  fireEvent.click(screen.getAllByRole("button", { name: "Zielpreis setzen" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Empfehlung übernehmen" }));
  fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

  await waitFor(() => {
    const patchCall = requestMock.mock.calls.find(
      ([path, options]) =>
        path === `/inventory/${ITEM_ID}` &&
        options &&
        typeof options === "object" &&
        "method" in options &&
        (options as { method?: string }).method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    const payload = (patchCall?.[1] as { json?: Record<string, unknown> }).json ?? {};
    expect(payload.target_price_mode).toBe("MANUAL");
    expect(payload.manual_target_sell_price_cents).toBe(3940);
  });
});

it("wires bulk preview and apply requests", async () => {
  renderPage();

  await screen.findAllByText("Mario Kart 64");
  fireEvent.click(screen.getByRole("button", { name: "Bulk Pricing" }));
  fireEvent.click(screen.getByRole("button", { name: "Vorschau anzeigen" }));

  await screen.findByText(/Treffer:/i);
  const previewCall = requestMock.mock.calls.find(
    ([path, options]) => path === "/inventory/target-pricing/preview" && (options as { method?: string })?.method === "POST",
  );
  expect(previewCall).toBeTruthy();
  expect((previewCall?.[1] as { json?: Record<string, unknown> }).json?.operation).toBe("APPLY_RECOMMENDED_MANUAL");

  fireEvent.click(screen.getByRole("button", { name: "Anwenden" }));
  await screen.findByText(/Bulk-Operation abgeschlossen/i);

  const applyCall = requestMock.mock.calls.find(
    ([path, options]) => path === "/inventory/target-pricing/apply" && (options as { method?: string })?.method === "POST",
  );
  expect(applyCall).toBeTruthy();
  expect((applyCall?.[1] as { json?: Record<string, unknown> }).json?.operation).toBe("APPLY_RECOMMENDED_MANUAL");
});
