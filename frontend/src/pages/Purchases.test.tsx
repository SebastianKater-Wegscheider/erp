import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

// Purchases uses Leaflet maps for mileage previews. Leaflet/react-leaflet can hang in jsdom during
// module initialization, so we mock them for unit tests focused on form behavior.
vi.mock("leaflet", () => ({
  latLngBounds: vi.fn(() => ({})),
}));

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children?: ReactNode }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  Polyline: () => null,
  CircleMarker: () => null,
  useMap: () => ({ fitBounds: vi.fn() }),
}));

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  useApi: () => ({
    request: requestMock,
    fileBlob: vi.fn(async () => new Blob()),
    download: vi.fn(async () => undefined),
  }),
}));

async function renderPage() {
  const { PurchasesPage } = await import("./Purchases");

  requestMock.mockImplementation(async (path: string) => {
    if (path === "/master-products") return [];
    if (path === "/purchases") return [];
    if (path === "/mileage") return [];
    if (path === "/amazon-scrapes/fee-profile") {
      return { referral_fee_bp: 1500, fulfillment_fee_cents: 350, inbound_shipping_cents: 0 };
    }
    if (path === "/reports/tax-profile") {
      return { vat_enabled: false, small_business_notice: "Kleinunternehmer" };
    }
    if (path.startsWith("/purchases/") && path.endsWith("/attachments")) return [];
    if (path.startsWith("/purchases/") && path.endsWith("/mileage")) return null;
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
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    writable: true,
  });
});

it("shows PAIV-specific position inputs", async () => {
  await renderPage();

  fireEvent.click(await screen.findByRole("button", { name: /Einkauf erfassen/i }));
  fireEvent.click(screen.getAllByRole("combobox")[0]);
  fireEvent.click(await screen.findByText("Private Sacheinlage (PAIV)"));

  fireEvent.click(screen.getByRole("button", { name: /Weiter zu Positionen/i }));
  fireEvent.click(screen.getByRole("button", { name: /Position hinzufügen/i }));

  expect(await screen.findByPlaceholderText("Marktwert (EUR)")).toBeInTheDocument();
  expect(await screen.findByText(">12 Monate Privatbesitz")).toBeInTheDocument();
}, 15_000);
