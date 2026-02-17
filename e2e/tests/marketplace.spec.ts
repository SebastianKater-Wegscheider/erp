import { expect, test } from "@playwright/test";

import { createMasterProductViaApi, createPurchaseViaApi, getSalesOrderViaApi, listInventoryViaApi, loginViaUi } from "./helpers";

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
  const importJson = (await (await importResponse).json()) as { ready_orders_count: number; staged_orders_count: number };
  expect(importJson.staged_orders_count).toBeGreaterThan(0);
  expect(importJson.ready_orders_count).toBe(1);

  await page.getByRole("tab", { name: "Apply" }).click();

  const applyResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/v1/marketplace/staged-orders/apply") &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Apply READY from batch" }).click();
  const applyJson = (await (await applyResponse).json()) as {
    results: Array<{ ok: boolean; sales_order_id: string | null; error?: string | null }>;
  };
  expect(applyJson.results).toHaveLength(1);
  expect(applyJson.results[0]?.ok).toBeTruthy();
  expect(applyJson.results[0]?.sales_order_id).toBeTruthy();

  await expect(page.getByText("OK")).toBeVisible();

  const sale = await getSalesOrderViaApi(request, String(applyJson.results[0]?.sales_order_id));
  expect(sale.status).toBe("FINALIZED");
  expect(sale.lines.length).toBeGreaterThan(0);
  expect(sale.lines[0]?.inventory_item_id).toBeTruthy();
});
