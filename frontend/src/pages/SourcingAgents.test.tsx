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
  const { SourcingAgentsPage } = await import("./SourcingAgents");

  requestMock.mockImplementation(async (path: string, opts?: RequestInit & { json?: unknown }) => {
    if (path === "/sourcing/agents" && !opts?.method) {
      return [];
    }
    if (path === "/sourcing/agents" && opts?.method === "POST") {
      return {
        id: "a1",
        name: "Gamecube Agent",
        enabled: true,
        interval_seconds: 21600,
        queries: [],
      };
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
      <MemoryRouter>
        <SourcingAgentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

it("creates an agent via POST", async () => {
  await renderPage();

  await screen.findByText(/neuen agent anlegen/i, {}, { timeout: 15_000 });
  fireEvent.change(screen.getByPlaceholderText("Gamecube Radar"), { target: { value: "Gamecube Agent" } });
  fireEvent.click(screen.getByRole("button", { name: /agent erstellen/i }));

  await waitFor(() => {
    expect(requestMock).toHaveBeenCalledWith(
      "/sourcing/agents",
      expect.objectContaining({
        method: "POST",
        json: expect.objectContaining({
          name: "Gamecube Agent",
        }),
      }),
    );
  });
}, 40_000);
