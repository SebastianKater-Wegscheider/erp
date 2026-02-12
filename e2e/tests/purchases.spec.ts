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
  await expect(page.getByRole("table").getByText("Bar ohne Fahrt")).toBeVisible();
});

test("inline purchase mileage supports OSM route calculation", async ({ page, request }) => {
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const productTitle = `E2E Route Product ${unique}`;

  await createMasterProductViaApi(request, { title: productTitle });
  await loginViaUi(page);
  await page.goto("/purchases");

  await page.route("https://nominatim.openstreetmap.org/search?*", async (route) => {
    const url = new URL(route.request().url());
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    if (q.includes("lager")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([{ lat: "47.5", lon: "9.7" }]),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{ lat: "47.6", lon: "9.8" }]),
    });
  });

  await page.route("https://router.project-osrm.org/route/v1/driving/*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        routes: [
          {
            distance: 12_345,
            geometry: {
              coordinates: [
                [9.7, 47.5],
                [9.75, 47.55],
                [9.8, 47.6],
              ],
            },
          },
        ],
      }),
    });
  });

  await page.getByRole("button", { name: "Einkauf erfassen" }).click();
  const dialog = page.getByRole("dialog", { name: "Einkauf erfassen" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("Name").fill(`E2E Route Seller ${unique}`);
  await dialog.getByRole("button", { name: "Hinzufügen", exact: true }).click();
  await dialog.getByPlaceholder("z. B. Lager").fill("Lager");
  await dialog.getByPlaceholder("z. B. Verkäuferadresse").fill("Verkäufer");
  await dialog.getByRole("button", { name: "Route berechnen" }).click();

  await expect(dialog.getByText("Berechnet: 12.35 km")).toBeVisible();
  await expect(dialog.getByPlaceholder("z. B. 12.4")).toHaveValue("12.35");

  await dialog.getByRole("button", { name: "Hin- und Rückfahrt" }).click();
  await expect(dialog.getByPlaceholder("z. B. 12.4")).toHaveValue("24.69");

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
  const mileageResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /\/api\/v1\/purchases\/[^/]+\/mileage/.test(response.url()) &&
      response.status() === 200,
  );

  await dialog.getByRole("button", { name: "Erstellen", exact: true }).click();
  await createResponse;
  await mileageResponse;

  await expect(dialog).toBeHidden();
});
