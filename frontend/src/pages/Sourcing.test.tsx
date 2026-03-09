import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

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
  const { SourcingPage } = await import("./Sourcing");

  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SourcingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

it("uses 40-item pagination and supports discard in the codex inbox", async () => {
  requestMock.mockImplementation(async (path: string, opts?: RequestInit & { json?: unknown }) => {
    if (path === "/sourcing/health") {
      return {
        status: "healthy",
        scraper_status: "ok",
        items_pending_evaluation: 1,
        items_failed_evaluation: 0,
      };
    }

    if (path === "/sourcing/stats") {
      return {
        total_items_scraped: 80,
        items_by_status: { NEW: 2 },
        items_by_evaluation_status: { PENDING: 1, COMPLETED: 1 },
        items_by_recommendation: { BUY: 1, WATCH: 1 },
      };
    }

    if (path.startsWith("/sourcing/items?") && !opts?.method) {
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      const limit = Number(params.get("limit") ?? "0");
      const offset = Number(params.get("offset") ?? "0");
      expect(limit).toBe(40);

      if (offset === 0) {
        return {
          items: [
            {
              id: "item-1",
              platform: "KLEINANZEIGEN",
              title: "Gamecube Bundle 1",
              price_cents: 9500,
              location_city: "Wien",
              primary_image_url: null,
              status: "NEW",
              evaluation_status: "COMPLETED",
              recommendation: "BUY",
              evaluation_summary: "Strong margin after Codex review.",
              expected_profit_cents: 3200,
              expected_roi_bp: 5100,
              max_buy_price_cents: 11000,
              evaluation_finished_at: "2026-03-09T10:00:00Z",
              evaluation_last_error: null,
              scraped_at: "2026-03-09T09:00:00Z",
              posted_at: "2026-03-09T08:30:00Z",
              url: "https://example.com/1",
            },
          ],
          total: 80,
          limit,
          offset,
        };
      }

      if (offset === 40) {
        return {
          items: [
            {
              id: "item-2",
              platform: "EBAY_DE",
              title: "Gamecube Bundle 2",
              price_cents: 12000,
              location_city: "Graz",
              primary_image_url: null,
              status: "NEW",
              evaluation_status: "PENDING",
              recommendation: null,
              evaluation_summary: null,
              expected_profit_cents: null,
              expected_roi_bp: null,
              max_buy_price_cents: null,
              evaluation_finished_at: null,
              evaluation_last_error: null,
              scraped_at: "2026-03-09T09:10:00Z",
              posted_at: "2026-03-09T08:50:00Z",
              url: "https://example.com/2",
            },
          ],
          total: 80,
          limit,
          offset,
        };
      }

      return { items: [], total: 80, limit, offset };
    }

    if (path === "/sourcing/items/item-1/discard" && opts?.method === "POST") {
      return undefined;
    }

    throw new Error(`Unhandled request in test: ${path}`);
  });

  await renderPage();
  await screen.findByText("Gamecube Bundle 1", {}, { timeout: 20_000 });
  await screen.findByText("BUY");

  fireEvent.click(screen.getByRole("button", { name: /Verwerfen/i }));

  await waitFor(() => {
    expect(requestMock).toHaveBeenCalledWith(
      "/sourcing/items/item-1/discard",
      expect.objectContaining({ method: "POST" }),
    );
  });

  fireEvent.click(screen.getByRole("button", { name: /Weiter/i }));
  await waitFor(() => {
    expect(
      requestMock.mock.calls.some(([path, opts]) => (
        typeof path === "string"
        && path.startsWith("/sourcing/items?")
        && path.includes("offset=40")
        && (!opts || !(opts as RequestInit).method)
      )),
    ).toBe(true);
  });
  await screen.findByText("Seite 2 von 2");
});
