import { expect, type APIRequestContext, type Page } from "@playwright/test";

const E2E_USER = process.env.E2E_USER ?? process.env.BASIC_AUTH_USERNAME ?? "test-user";
const E2E_PASS = process.env.E2E_PASS ?? process.env.BASIC_AUTH_PASSWORD ?? "test-pass";
const E2E_API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://localhost:18000/api/v1";

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function authJsonHeaders(): Record<string, string> {
  return {
    Authorization: basicAuthHeader(E2E_USER, E2E_PASS),
    "Content-Type": "application/json",
  };
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
    headers: authJsonHeaders(),
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

export async function createMileageViaApi(
  request: APIRequestContext,
  options: {
    purchaseIds: string[];
    logDate?: string;
    startLocation?: string;
    destination?: string;
    km?: string;
    purpose?: "BUYING" | "POST" | "MATERIAL" | "OTHER";
  },
): Promise<string> {
  const {
    purchaseIds,
    logDate = "2026-02-12",
    startLocation = "Lager",
    destination = "Verkaeufer",
    km = "8.5",
    purpose = "BUYING",
  } = options;
  const response = await request.post(`${E2E_API_BASE_URL}/mileage`, {
    headers: authJsonHeaders(),
    data: {
      log_date: logDate,
      start_location: startLocation,
      destination,
      purpose,
      km,
      purchase_ids: purchaseIds,
    },
  });

  expect(response.ok(), `mileage create failed (${response.status()})`).toBeTruthy();
  const json = (await response.json()) as { id: string };
  expect(json.id).toBeTruthy();
  return json.id;
}

export async function createPurchaseViaApi(
  request: APIRequestContext,
  options: {
    counterpartyName: string;
    purchaseDate?: string;
    paymentSource?: "CASH" | "BANK";
    masterProductId: string;
    purchasePriceCents?: number;
  },
): Promise<string> {
  const {
    counterpartyName,
    purchaseDate = "2026-02-14",
    paymentSource = "CASH",
    masterProductId,
    purchasePriceCents = 1000,
  } = options;

  const response = await request.post(`${E2E_API_BASE_URL}/purchases`, {
    headers: authJsonHeaders(),
    data: {
      kind: "PRIVATE_DIFF",
      purchase_date: purchaseDate,
      counterparty_name: counterpartyName,
      counterparty_address: null,
      counterparty_birthdate: null,
      counterparty_id_number: null,
      source_platform: "E2E",
      listing_url: null,
      notes: null,
      total_amount_cents: purchasePriceCents,
      shipping_cost_cents: 0,
      buyer_protection_fee_cents: 0,
      tax_rate_bp: 0,
      payment_source: paymentSource,
      lines: [
        {
          master_product_id: masterProductId,
          condition: "GOOD",
          purchase_type: "DIFF",
          purchase_price_cents: purchasePriceCents,
        },
      ],
    },
  });

  expect(response.ok(), `purchase create failed (${response.status()})`).toBeTruthy();
  const json = (await response.json()) as { id: string };
  expect(json.id).toBeTruthy();
  return json.id;
}

export async function listInventoryViaApi(
  request: APIRequestContext,
  options: { q?: string; status?: string; limit?: number; offset?: number },
): Promise<Array<{ id: string; item_code: string; master_product_id: string; status: string }>> {
  const { q, status, limit = 50, offset = 0 } = options;
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (q) params.set("q", q);
  if (status) params.set("status", status);

  const response = await request.get(`${E2E_API_BASE_URL}/inventory?${params.toString()}`, {
    headers: { Authorization: basicAuthHeader(E2E_USER, E2E_PASS) },
  });
  expect(response.ok(), `inventory list failed (${response.status()})`).toBeTruthy();
  return (await response.json()) as Array<{ id: string; item_code: string; master_product_id: string; status: string }>;
}
