import { expect, type APIRequestContext, type Page } from "@playwright/test";

const E2E_USER = process.env.E2E_USER ?? process.env.BASIC_AUTH_USERNAME ?? "test-user";
const E2E_PASS = process.env.E2E_PASS ?? process.env.BASIC_AUTH_PASSWORD ?? "test-pass";
const E2E_API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://localhost:18000/api/v1";

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export async function loginViaUi(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.removeItem("erp.basicAuth");
  });
  await page.reload();

  const usernameField = page.locator('input[autocomplete="username"]');
  const passwordField = page.locator('input[autocomplete="current-password"]');
  const saveButton = page.getByRole("button", { name: "Zugangsdaten speichern" });

  await expect(saveButton).toBeVisible();
  await usernameField.fill(E2E_USER);
  await passwordField.fill(E2E_PASS);
  await saveButton.click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("link", { name: /^Übersicht$/ })).toHaveAttribute("aria-current", "page");
}

export async function createMasterProductViaApi(
  request: APIRequestContext,
  options: { title: string; platform?: string; region?: string },
): Promise<string> {
  const { title, platform = "Nintendo Switch", region = "EU" } = options;
  const response = await request.post(`${E2E_API_BASE_URL}/master-products`, {
    headers: {
      Authorization: basicAuthHeader(E2E_USER, E2E_PASS),
      "Content-Type": "application/json",
    },
    data: {
      kind: "GAME",
      title,
      platform,
      region,
      variant: "",
    },
  });

  expect(response.ok(), `master-product create failed (${response.status()})`).toBeTruthy();
  const json = (await response.json()) as { id: string };
  expect(json.id).toBeTruthy();
  return json.id;
}
