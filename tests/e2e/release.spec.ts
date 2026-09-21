import { expect, type Page, test } from "@playwright/test";

async function holdShortcut(page: Page, holdMs = 350) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.down("Space");
  await page.waitForTimeout(holdMs);
  await page.keyboard.up("Space");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}

async function tapShortcut(page: Page) {
  await page.keyboard.press("Control+Shift+Space");
}

test("release onboarding requires and recognizes both real gestures", async (
  { page },
) => {
  await page.goto("/");
  await expect(page.getByLabel("Development scenarios")).toHaveCount(0);
  // Step 1: in browser (non-Tauri) native capture is unavailable;
  // Next is not blocked by permission — proceed directly.
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Press-and-hold · not tested")).toBeVisible();
  await expect(page.getByText("Rapid double-tap · not tested")).toBeVisible();
  await expect(page.getByRole("button", { name: "Test hold" }))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: "Test double-tap" }))
    .toHaveCount(0);
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByRole("alert")).toContainText("both practice");
  await holdShortcut(page);
  await expect(page.getByText("Press-and-hold · recognized")).toBeVisible();
  await tapShortcut(page);
  await tapShortcut(page);
  await tapShortcut(page);
  await expect(page.getByText("Rapid double-tap · recognized")).toBeVisible();
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByRole("dialog", { name: "Set up Voxloom" }))
    .toHaveCount(0);
});
