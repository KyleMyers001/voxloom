import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function skipOnboarding(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Skip" }).click();
}

test("first run reaches a successful mock dictation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: "Set up Voxloom" }))
    .toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/onboarding.png",
  });
  await page.getByRole("button", { name: "Enable mock microphone" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Test hold" }).click();
  await page.getByRole("button", { name: "Test double-tap" }).click();
  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("button", { name: "Start mock dictation" }).click();
  await expect(page.getByRole("img", { name: "silent mock waveform" }))
    .toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/listening-system.png",
  });
  await page.getByRole("button", { name: "Finish mock dictation" }).click();
  await page.getByRole("button", { name: "Complete mock result" }).click();
  await expect(page.getByText(
    "Keep the TypeScript boundary small and explicit.",
  )).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Dark").check();
  await page.getByRole("button", { name: "Home" }).click();
  await page.screenshot({
    fullPage: true,
    path: "artifacts/screenshots/home-dark.png",
  });
});

test("screens, settings, and themes share state", async ({ page }) => {
  await page.goto("/");
  await skipOnboarding(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Dark").check();
  await page.getByRole("button", { name: "Dictionary" }).click();
  await page.getByRole("button", { name: "Add term" }).click();
  await page.getByRole("textbox", { name: "Word" }).fill(" Vite ");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Vite", { exact: true })).toBeVisible();
  await page.getByRole("searchbox").fill("vite");
  await expect(page.getByText("Postgres")).toBeHidden();
  await page.screenshot({
    fullPage: true,
    path: "artifacts/screenshots/dictionary-dark.png",
  });
  await page.getByRole("button", { name: "History" }).click();
  await page.getByLabel("History status").selectOption("failed");
  await page.getByRole("article").hover();
  await expect(page.getByRole("button", {
    name: "Retry transcription",
  })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Current style").selectOption("casual");
  for (const theme of ["Light", "Dark", "Sodium Rain", "Follow system"]) {
    await page.getByLabel(theme).check();
    await expect(page.getByLabel(theme)).toBeChecked();
  }
  await page.getByLabel("Sodium Rain").check();
  await page.screenshot({
    fullPage: true,
    path: "artifacts/screenshots/settings-sodium-rain.png",
  });
  await page.keyboard.press("Alt+1");
  await expect(page.getByRole("button", { exact: true, name: "Casual" }))
    .toHaveAttribute("aria-pressed", "true");
});

test("keyboard, narrow layout, and accessibility work", async ({ page }) => {
  await page.setViewportSize({ height: 760, width: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await skipOnboarding(page);
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Listening · speaking" }).click();
  await expect(page.locator(".wave i").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.getByRole("button", { name: "Cancel" }).last().click();
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(({ impact }) =>
    impact === "critical" || impact === "serious"
  );
  expect(serious).toEqual([]);
  await page.screenshot({
    fullPage: true,
    path: "artifacts/screenshots/home-narrow.png",
  });
});

test("mock scenarios cover cancel, error, retry, and expiry", async (
  { page },
) => {
  await page.goto("/");
  await skipOnboarding(page);
  await page.getByRole("button", { name: "Listening · silent" }).click();
  await expect(page.getByRole("img", { name: "silent mock waveform" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Listening · speaking" }).click();
  await expect(page.getByRole("img", { name: "speaking mock waveform" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Processing" }).click();
  await page.getByRole("button", { name: "Complete error" }).click();
  await page.getByRole("button", { name: "History" }).click();
  await page.getByLabel("History status").selectOption("failed");
  await page.getByRole("article").first().hover();
  await page.screenshot({
    path: "artifacts/screenshots/history-failed.png",
  });
  await page.getByRole("button", { name: "Retry transcription" }).first()
    .click();
  await expect(page.getByRole("img")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.getByRole("img")).toBeHidden();
  await page.getByRole("button", { name: "Expire recovery buffers" }).click();
  await page.getByRole("button", { name: "History" }).click();
  await page.getByLabel("History status").selectOption("failed");
  for (const article of await page.getByRole("article").all()) {
    await article.hover();
  }
  await expect(page.getByRole("button", { name: "Retry transcription" }))
    .toHaveCount(0);
  await page.getByLabel("Copy failure").check();
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "Copy dictation" }).first().click();
  await expect(page.getByText("Copy failed")).toBeVisible();
  await page.getByRole("button", { name: "Empty lists" }).click();
  await expect(page.getByText("No dictations yet.")).toBeVisible();
  await page.screenshot({
    path: "artifacts/screenshots/home-empty.png",
  });
});
