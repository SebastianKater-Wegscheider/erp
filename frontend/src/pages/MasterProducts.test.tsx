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
    amazon_price_used_good_cents: 4234,
  },
  {
    id: "00000000-0000-0000-0000-000000000333",
    sku: "SKU-333",
    kind: "GAME",
    title: "Low Potential Product",
    platform: "PS4",
    region: "EU",
    variant: "Standard",
    ean: "3333333333333",
    asin: "B000TEST33",
    manufacturer: "Ubisoft",
    amazon_last_success_at: "2026-02-11T00:00:00.000Z",
    amazon_rank_specific: 90000,
    amazon_offers_count_used_priced_total: 14,
    amazon_price_used_good_cents: 1999,
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

function renderPage(
  initialEntry: string,
  handler?: (path: string, options?: { method?: string; json?: unknown }) => unknown | Promise<unknown>,
) {
  requestMock.mockImplementation(async (path: string, options?: { method?: string; json?: unknown }) => {
    if (handler) return await handler(path, options);
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

it("keeps UUID out of row body and has no UUID copy action", async () => {
  renderPage("/master-products");

  await screen.findAllByText("With ASIN Product");
  expect(screen.queryByText(/UUID:/i)).toBeNull();
  expect(screen.queryByText("UUID kopieren")).toBeNull();
});

it("hides EAN chips in Amazon mode and shows BSR/price target cues", async () => {
  renderPage("/master-products?view=catalog");

  await screen.findAllByText("With ASIN Product");
  expect(screen.queryAllByText(/EAN:/).length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "Amazon Status" }));
  expect(await screen.findAllByText(/BSR Gesamt/i)).not.toHaveLength(0);
  expect(screen.queryAllByText(/Verkaufspreis/i).length).toBeGreaterThan(0);
  expect(screen.queryAllByText(/>= 40 EUR/i).length).toBeGreaterThan(0);
  expect(screen.queryAllByText(/EAN:/)).toHaveLength(0);
  expect(screen.queryAllByText(/ASIN:/)).toHaveLength(0);
});

it("filters Amazon view to top reseller targets", async () => {
  renderPage("/master-products?view=amazon");

  await screen.findAllByText("With ASIN Product");
  await screen.findAllByText("Low Potential Product");

  fireEvent.click(screen.getAllByRole("button", { name: "Top Targets 40+" })[0]);

  await waitFor(() => {
    expect(screen.queryByText("Low Potential Product")).toBeNull();
    expect(screen.queryByText("No ASIN Product")).toBeNull();
  });
  expect(screen.queryAllByText("With ASIN Product").length).toBeGreaterThan(0);
});

it("uses in-stock quick filter via backend query param", async () => {
  renderPage("/master-products", async (path) => {
    if (path === "/master-products") return PRODUCTS;
    if (path === "/master-products?in_stock_only=true") return [PRODUCTS[0]];
    throw new Error(`Unhandled request in test: ${path}`);
  });

  await screen.findAllByText("With ASIN Product");
  fireEvent.click(screen.getByRole("button", { name: "Auf Lager" }));

  await waitFor(() => {
    expect(requestMock).toHaveBeenCalledWith("/master-products?in_stock_only=true");
  });
});

it("imports CSV text and shows summary", async () => {
  const csvText = "title,platform,region\nWave Race 64,Nintendo 64,EU";
  renderPage("/master-products", async (path, options) => {
    if (path === "/master-products") return PRODUCTS;
    if (path === "/master-products/bulk-import") {
      expect(options?.method).toBe("POST");
      expect(options?.json).toEqual({ csv_text: csvText });
      return {
        total_rows: 1,
        imported_count: 1,
        failed_count: 0,
        skipped_count: 0,
        errors: [],
      };
    }
    throw new Error(`Unhandled request in test: ${path}`);
  });

  await screen.findAllByText("With ASIN Product");

  fireEvent.click(screen.getAllByRole("button", { name: "CSV Import" })[0]);
  fireEvent.change(screen.getByLabelText("CSV-Text"), { target: { value: csvText } });
  fireEvent.click(screen.getByRole("button", { name: "Import starten" }));

  expect(await screen.findByText("Importiert: 1")).toBeTruthy();
  expect(screen.getByText("Fehler: 0")).toBeTruthy();
});

it("shows row-level CSV import errors", async () => {
  const csvText = "title,platform\nInvalid Row,";
  renderPage("/master-products", async (path) => {
    if (path === "/master-products") return PRODUCTS;
    if (path === "/master-products/bulk-import") {
      return {
        total_rows: 1,
        imported_count: 0,
        failed_count: 1,
        skipped_count: 0,
        errors: [{ row_number: 2, title: "Invalid Row", message: "platform: Field required" }],
      };
    }
    throw new Error(`Unhandled request in test: ${path}`);
  });

  await screen.findAllByText("With ASIN Product");

  fireEvent.click(screen.getAllByRole("button", { name: "CSV Import" })[0]);
  fireEvent.change(screen.getByLabelText("CSV-Text"), { target: { value: csvText } });
  fireEvent.click(screen.getByRole("button", { name: "Import starten" }));
  fireEvent.click(await screen.findByRole("button", { name: "Fehler anzeigen (1)" }));

  expect(await screen.findByText("Zeile 2")).toBeTruthy();
  expect(screen.getByText(/platform: Field required/i)).toBeTruthy();
});
