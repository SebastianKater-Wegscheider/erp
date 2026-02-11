import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";

import { MasterProductsPage } from "./MasterProducts";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  useApi: () => ({ request: requestMock }),
}));

type MockMasterProduct = {
  id: string;
  sku: string;
  kind: "GAME" | "CONSOLE" | "ACCESSORY" | "OTHER";
  title: string;
  platform: string;
  region: string;
  variant: string;
  ean?: string | null;
  asin?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  genre?: string | null;
  release_year?: number | null;
  amazon_last_success_at?: string | null;
  amazon_rank_specific?: number | null;
  amazon_offers_count_used_priced_total?: number | null;
  amazon_price_used_good_cents?: number | null;
};

const PRODUCTS: MockMasterProduct[] = [
  {
    id: "00000000-0000-0000-0000-000000000111",
    sku: "SKU-111",
    kind: "GAME",
    title: "With ASIN Product",
    platform: "PS2",
    region: "EU",
    variant: "Standard",
    ean: "1111111111111",
    asin: "B000TEST11",
    manufacturer: "Sony",
    amazon_last_success_at: "2026-02-11T00:00:00.000Z",
    amazon_rank_specific: 400,
    amazon_offers_count_used_priced_total: 1,
    amazon_price_used_good_cents: 1234,
  },
  {
    id: "00000000-0000-0000-0000-000000000222",
    sku: "SKU-222",
    kind: "GAME",
    title: "No ASIN Product",
    platform: "Switch",
    region: "EU",
    variant: "Deluxe",
    ean: "2222222222222",
    asin: null,
    manufacturer: "Nintendo",
  },
];

function renderPage(initialEntry: string) {
  requestMock.mockImplementation(async (path: string) => {
    if (path === "/master-products") return PRODUCTS;
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
          <Route path="/master-products" element={<MasterProductsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
  localStorage.clear();
});

it("shows Amazon health in Amazon Status mode and reveals signals in details", async () => {
  renderPage("/master-products?view=catalog");

  await screen.findAllByText("With ASIN Product");
  expect(screen.queryByText("fresh")).toBeNull();
  expect(screen.queryByText("Abverkauf")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Amazon Status" }));
  expect(await screen.findAllByText("fresh")).not.toHaveLength(0);
  expect(screen.queryByText("Abverkauf")).toBeNull();

  fireEvent.click(screen.getAllByRole("button", { name: "Details ausklappen" })[0]);
  expect(await screen.findAllByText("Abverkauf")).not.toHaveLength(0);
});

it("filters rows by missing ASIN via query param", async () => {
  renderPage("/master-products?missing=asin&view=catalog");

  await screen.findAllByText("No ASIN Product");
  await waitFor(() => {
    expect(screen.queryByText("With ASIN Product")).toBeNull();
  });
});

it("keeps UUID out of row body and exposes copy action", async () => {
  renderPage("/master-products");

  await screen.findAllByText("With ASIN Product");
  expect(screen.queryByText(/UUID:/i)).toBeNull();

  const actionButtons = screen.getAllByRole("button", { name: "Aktionen" });
  for (const button of actionButtons) {
    fireEvent.pointerDown(button);
    fireEvent.click(button);
  }
  const copyItems = await screen.findAllByText("UUID kopieren");
  expect(copyItems.length).toBeGreaterThan(0);
});

it("hides EAN chips in Amazon mode and keeps ASIN copy chip", async () => {
  renderPage("/master-products?view=catalog");

  await screen.findAllByText("With ASIN Product");
  expect(screen.queryAllByText(/EAN:/).length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "Amazon Status" }));
  expect(await screen.findAllByText(/ASIN:/)).not.toHaveLength(0);
  expect(screen.queryAllByText(/EAN:/)).toHaveLength(0);
});
