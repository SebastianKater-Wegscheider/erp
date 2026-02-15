import { expect, test } from "@playwright/test";

import { createMasterProductViaApi, createPurchaseViaApi, listInventoryViaApi, loginViaUi } from "./helpers";

test("import marketplace orders via CSV auto-matches IT-... and applies to finalized sale", async ({ page, request }) => {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const productTitle = `E2E Marketplace Product ${unique}`;
  const sellerName = `E2E Marketplace Seller ${unique}`;
  const externalOrderId = `E2E-AO-${unique}`;

  const mpId = await createMasterProductViaApi(request, { title: productTitle });
  await createPurchaseViaApi(request, { counterpartyName: sellerName, masterProductId: mpId, purchaseDate: "2026-02-14" });

  const inv = await listInventoryViaApi(request, { q: productTitle, status: "AVAILABLE", limit: 10 });
  expect(inv.length).toBeGreaterThan(0);
  const itemCode = inv[0].item_code;
  expect(itemCode).toMatch(/^IT-[A-Z0-9]{12}$/);

  await loginViaUi(page);
  await page.goto("/marketplace");
  await expect(page).toHaveURL(/\/marketplace/);

  const csvText = [
    "channel,external_order_id,order_date,sku,sale_gross_eur,shipping_gross_eur",
    `AMAZON,${externalOrderId},2026-02-15,${itemCode},29.99,0`,
  ].join("\n");

  await page.locator("textarea").first().fill(csvText);

  const importResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/v1/marketplace/imports/orders") &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Import" }).click();
  await importResponse;

  // Summary shows READY=1.
  await expect(page.getByText("READY")).toBeVisible();
  await expect(page.getByText("1")).toBeVisible();

  await page.getByRole("tab", { name: "Apply" }).click();

  const applyResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/v1/marketplace/staged-orders/apply") &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Apply READY from batch" }).click();
  await applyResponse;

  await expect(page.getByText("OK")).toBeVisible();

  // Inventory item must be SOLD after apply.
  const invAfter = await listInventoryViaApi(request, { q: itemCode, limit: 5 });
  expect(invAfter.find((i) => i.item_code === itemCode)?.status).toBe("SOLD");
});

