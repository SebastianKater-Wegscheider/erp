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

it("uses 40-item pagination and supports inline discard", async () => {
  requestMock.mockImplementation(async (path: string, opts?: RequestInit & { json?: unknown }) => {
    if (path === "/sourcing/health") {
      return {
        status: "healthy",
        scraper_status: "ok",
        items_pending_analysis: 0,
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
              estimated_profit_cents: 3200,
              estimated_roi_bp: 5100,
              status: "READY",
              scraped_at: "2026-02-17T18:00:00Z",
              posted_at: "2026-02-17T17:30:00Z",
              url: "https://example.com/1",
              match_count: 3,
            },
          ],
          total: 80,
          limit,
          offset,
        };
      }

      if (offset === 40) {
        await new Promise((resolve) => {
          setTimeout(resolve, 60);
        });
        return {
          items: [
            {
              id: "item-2",
              platform: "KLEINANZEIGEN",
              title: "Gamecube Bundle 2",
              price_cents: 12000,
              location_city: "Graz",
              primary_image_url: null,
              estimated_profit_cents: 4200,
              estimated_roi_bp: 6000,
              status: "READY",
              scraped_at: "2026-02-17T18:10:00Z",
              posted_at: "2026-02-17T17:50:00Z",
              url: "https://example.com/2",
              match_count: 4,
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

    if (path === "/sourcing/agents" && !opts?.method) {
      return [];
    }

    throw new Error(`Unhandled request in test: ${path}`);
  });

  await renderPage();
  await screen.findByText("Gamecube Bundle 1", {}, { timeout: 20_000 });

  fireEvent.click(screen.getByRole("button", { name: /Uninteressant/i }));

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
}, 40_000);
