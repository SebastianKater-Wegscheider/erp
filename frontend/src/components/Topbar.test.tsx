import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

import { Topbar } from "./Topbar";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ clearCredentials: vi.fn() }),
}));

vi.mock("../lib/taxProfile", () => ({
  useTaxProfile: () => ({ data: { vat_enabled: true } }),
}));

vi.mock("../lib/theme", () => ({
  getActiveTheme: () => "light",
  toggleTheme: () => "dark",
}));

it("does not auto-focus the mobile nav search input on open (prevents iOS keyboard pop)", async () => {
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0);
  }

  const originalWarn = console.warn;
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
    const msg = String(args[0] ?? "");
    if (msg.includes("React Router Future Flag Warning")) return;
    originalWarn(...args);
  });

  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Topbar />
    </MemoryRouter>,
  );

  const openButton = screen.getByRole("button", { name: "Navigation öffnen" });
  openButton.focus();
  fireEvent.click(openButton);

  const search = await screen.findByLabelText("Navigation durchsuchen");
  expect(document.activeElement).not.toBe(search);

  warnSpy.mockRestore();
});
