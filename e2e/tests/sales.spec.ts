import { expect, test } from "@playwright/test";

import { createMasterProductViaApi, createPurchaseViaApi, listInventoryViaApi, loginViaUi } from "./helpers";

test("sales finalize and return restock flow remains operational", async ({ page, request }) => {
  test.setTimeout(120_000);
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const productTitle = `E2E Sales Product ${unique}`;
  const sellerName = `E2E Sales Seller ${unique}`;
  const buyerName = `E2E Sales Buyer ${unique}`;

  const mpId = await createMasterProductViaApi(request, { title: productTitle });
  await createPurchaseViaApi(request, {
    counterpartyName: sellerName,
    masterProductId: mpId,
    purchaseDate: "2026-02-15",
  });

  const invBefore = await listInventoryViaApi(request, { q: productTitle, status: "AVAILABLE", limit: 10 });
  expect(invBefore.length).toBeGreaterThan(0);
  const targetItem = invBefore[0];

  await loginViaUi(page);
  await page.goto("/sales");
  await expect(page).toHaveURL(/\/sales/);

  await page.getByRole("button", { name: "Auftrag erstellen" }).click();
  const createDialog = page.getByRole("dialog", { name: "Auftrag erstellen" });
  await expect(createDialog).toBeVisible();

  await createDialog.getByLabel("Käufername").fill(buyerName);
  await createDialog.getByPlaceholder("SKU/Titel/EAN/ASIN suchen…").fill(productTitle);
  await createDialog.getByRole("button", { name: "Aktualisieren" }).click();
  await expect
    .poll(async () => await createDialog.getByRole("row").filter({ hasText: productTitle }).count(), { timeout: 20_000 })
    .toBeGreaterThan(0);

  const inventoryRow = createDialog.getByRole("row").filter({ hasText: productTitle }).first();
  await expect(inventoryRow).toBeVisible({ timeout: 20_000 });
  await inventoryRow.getByRole("button", { name: "Hinzufügen" }).click();

  const linesTable = createDialog.locator("table").nth(1);
  await linesTable.locator("tbody tr").first().locator("input").fill("29,99");

  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/v1\/sales$/.test(response.url()) &&
      response.status() === 200,
  );
  await createDialog.getByRole("button", { name: "Auftrag erstellen (ENTWURF)" }).click();
  const createdOrder = (await (await createResponse).json()) as { id: string };
  expect(createdOrder.id).toBeTruthy();
  await expect(createDialog).toBeHidden();

  const orderRow = page.getByRole("row").filter({ hasText: buyerName }).first();
  await expect(orderRow).toBeVisible();

  const finalizeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/v1/sales/${createdOrder.id}/finalize`) &&
      response.status() === 200,
  );
  await orderRow.getByRole("button", { name: "Abschließen" }).click();
  await finalizeResponse;
  await expect(orderRow.getByText("Abgeschlossen")).toBeVisible();

  const invAfterFinalize = await listInventoryViaApi(request, { q: targetItem.item_code, limit: 10 });
  expect(invAfterFinalize.find((item) => item.item_code === targetItem.item_code)?.status).toBe("SOLD");

  await orderRow.getByRole("button", { name: "Rückgabe / Korrektur" }).click();
  const returnDialog = page.getByRole("dialog", { name: "Rückgabe / Korrektur" });
  await expect(returnDialog).toBeVisible();

  const createReturnResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/v1/sales/${createdOrder.id}/returns`) &&
      response.status() === 200,
  );
  await returnDialog.getByRole("button", { name: "Korrektur erstellen" }).click();
  const createdReturn = (await (await createReturnResponse).json()) as { id: string };
  expect(createdReturn.id).toBeTruthy();

  await expect(returnDialog.getByText("Keine Korrekturen.")).toHaveCount(0);

  const invAfterReturn = await listInventoryViaApi(request, { q: targetItem.item_code, limit: 10 });
  expect(invAfterReturn.find((item) => item.item_code === targetItem.item_code)?.status).toBe("AVAILABLE");
});
