import { expect, test } from "@playwright/test";

test("login and load dashboard", async ({ page }) => {
  const user = process.env.E2E_USER ?? "test-user";
  const pass = process.env.E2E_PASS ?? "test-pass";

  await page.goto("/");

  await page.locator('input[autocomplete="username"]').fill(user);
  await page.locator('input[autocomplete="current-password"]').fill(pass);

  const dashboardResp = page.waitForResponse(
    (r) => r.url().includes("/api/v1/reports/company-dashboard") && r.status() === 200,
  );

  await page.getByRole("button", { name: "Zugangsdaten speichern" }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await dashboardResp;

  // "Uebersicht" is rendered with umlaut in the UI ("Übersicht"); use a stable ASCII substring.
  await expect(page.getByText(/bersicht/i)).toBeVisible();
});
