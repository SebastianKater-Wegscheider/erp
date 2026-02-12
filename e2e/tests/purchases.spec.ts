import { expect, test } from "@playwright/test";

import { createMasterProductViaApi, loginViaUi } from "./helpers";

test("create purchase via UI persists successfully", async ({ page, request }) => {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const productTitle = `E2E Purchase Product ${unique}`;
  const sellerName = `E2E Seller ${unique}`;

  await createMasterProductViaApi(request, { title: productTitle });
  await loginViaUi(page);
  await page.goto("/purchases");
  await expect(page).toHaveURL(/\/purchases/);

  await page.getByRole("button", { name: "Einkauf erfassen" }).click();
  const dialog = page.getByRole("dialog", { name: "Einkauf erfassen" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("Name").fill(sellerName);
  await dialog.getByRole("button", { name: "Weiter zu Positionen" }).click();

  await dialog.getByRole("button", { name: "Position hinzufügen" }).click();
  await expect(dialog.getByText("Produktstamm wird geladen…")).toHaveCount(0);

  const productInput = dialog.getByPlaceholder("Suchen (SKU, Titel, EAN, …) oder neu anlegen…");
  await productInput.fill(productTitle);
  const escapedTitle = productTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const optionButton = page.getByRole("button", { name: new RegExp(escapedTitle) }).first();
  await expect(optionButton).toBeVisible();
  await optionButton.click();
  await expect(productInput).toHaveValue(/·/);

  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/v1/purchases") &&
      response.status() === 200,
  );

  await dialog.getByRole("button", { name: "Erstellen", exact: true }).click();
  await createResponse;

  await expect(dialog).toBeHidden();
  await expect(page.getByRole("table").getByText(sellerName)).toBeVisible();
});
