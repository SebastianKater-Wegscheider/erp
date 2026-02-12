import { test } from "@playwright/test";

import { loginViaUi } from "./helpers";

test("login and load dashboard", async ({ page }) => {
  await loginViaUi(page);
  await test.step("dashboard shell is rendered", async () => {
    await page.getByRole("button", { name: "Aktualisieren" }).waitFor();
  });
});
