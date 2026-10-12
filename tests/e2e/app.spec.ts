import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const screens = ['Home', 'History', 'Dictionary', 'Settings'];
const themes = [
  ['Follow system', 'system'],
  ['Light', 'light'],
  ['Dark', 'dark'],
  ['Sodium Rain', 'sodium-rain'],
] as const;

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(({ impact }) =>
    impact === 'critical' || impact === 'serious'
  );
  expect(serious).toEqual([]);
}

async function holdShortcut(page: Page, holdMs = 350) {
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.down('Space');
  await page.waitForTimeout(holdMs);
  await page.keyboard.up('Space');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
}

async function tapShortcut(page: Page) {
  await page.keyboard.press('Control+Shift+Space');
}

/** The dev scenario panel sits in a collapsed "Developer" disclosure (CHECKLIST N10). */
async function openDevPanel(page: Page) {
  const summary = page.getByText('Developer', { exact: true });
  if (await page.locator('details.dev-panel[open]').count() === 0) await summary.click();
}

async function skipOnboarding(page: Page) {
  await page.getByRole('button', { name: 'Skip' }).click();
}

test('first run practices gestures without native capture', async ({ page }) => {
  await page.goto('/');
  const onboarding = page.getByRole('dialog', { name: 'Set up Voxloom' });
  await expect(onboarding).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({ path: 'artifacts/screenshots/onboarding.png' });
  // In browser (non-Tauri) context, step 1 shows native capture unavailable
  // and Next is not blocked by permission.
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await holdShortcut(page);
  await expect(page.getByText(/Press-and-hold · recognized/)).toBeVisible();
  await tapShortcut(page);
  await tapShortcut(page);
  await tapShortcut(page);
  await expect(page.getByText(/Rapid double-tap · recognized/)).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.down('Space');
  await page.waitForTimeout(350);
  // Native waveform lives in a separate window, never inside the main app.
  await expect(page.getByRole('img', { name: 'Microphone level' }))
    .toHaveCount(0);
  await page.screenshot({
    path: 'artifacts/screenshots/listening-system.png',
  });
  await page.keyboard.up('Space');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  // Browser mock gestures do not claim real STT or insertion.
  await expect(page.getByText(
    'Keep the TypeScript boundary small and explicit.',
  )).toHaveCount(0);
});

test('screens, settings, themes, and baselines stay synchronized', async (
  { page },
) => {
  await page.goto('/');
  await skipOnboarding(page);
  await page.getByRole('button', { name: 'Dictionary' }).click();
  await page.getByRole('button', { name: 'Add term' }).click();
  await expectAccessible(page);
  await page.getByRole('textbox', { name: 'Word' }).fill(' Vite ');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText(
    'Native microphone capture is unavailable here',
  )).toBeVisible();
  await expect(page.getByLabel('Microphone', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Unavailable' }))
    .toBeDisabled();
  await page.getByRole('radiogroup', { name: 'Current style' })
    .getByRole('radio', { exact: true, name: 'Casual' }).click();

  for (const screen of screens) {
    await page.getByRole('button', { name: screen }).click();
    await expectAccessible(page);
  }
  for (const [theme, slug] of themes) {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByLabel(theme).check();
    for (const screen of screens) {
      await page.getByRole('button', { name: screen }).click();
      await page.screenshot({
        fullPage: true,
        path: `artifacts/screenshots/baseline-${
          screen.toLowerCase()}-${slug}.png`,
      });
    }
  }
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await page.getByLabel('Follow system').check();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveAttribute(
    'data-appearance-resolved',
    'dark',
  );
  expect(await page.locator('body').evaluate((body) =>
    getComputedStyle(body).getPropertyValue('--bg').trim()
  )).toBe('#0b0b10');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveAttribute(
    'data-appearance-resolved',
    'light',
  );
  expect(await page.locator('body').evaluate((body) =>
    getComputedStyle(body).getPropertyValue('--bg').trim()
  )).toBe('#fbfbf8');
  // ⌥-digits are ignored while a form control has focus (UI PR 3), so blur first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Alt+1');
  await expect(page.getByRole('radio', { exact: true, name: 'Casual' }))
    .toHaveAttribute('aria-checked', 'true');
});

test('every Settings tab passes axe in light and dark', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByLabel(theme, { exact: true }).check();
    for (const tab of ['Capture', 'Models', 'Appearance', 'Privacy']) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
      await expectAccessible(page);
    }
  }
});

test('settings.html (the native Settings window entry) renders and passes axe', async ({ page }) => {
  await page.goto('/settings.html');
  await expect(page.getByRole('tablist', { name: 'Settings sections' })).toBeVisible();
  await page.getByRole('tab', { name: 'Privacy' }).click();
  await expectAccessible(page);
});

test('the 760×600 Settings window keeps two-column rows and a two-column recovery grid (QA #42)', async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 760 });
  await page.goto('/settings.html');
  const cols = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(await cols('.settings-rows .frow')).toBe(2);
  await page.getByRole('tab', { name: 'Privacy' }).click();
  expect(await cols('.settings-rows .frow')).toBe(2);
  expect(await cols('.recovery-grid')).toBe(2);
  await page.getByRole('tab', { name: 'Appearance' }).click();
  expect(await cols('.appearance-options')).toBe(3);
});

test('the shortcut field does not move while typing (QA #41)', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const field = page.getByLabel('Shortcut', { exact: true });
  await field.click();
  const before = await field.boundingBox();
  for (const key of ['+', 'A', 'l', 't', '+', 'K']) {
    await field.press(key);
    expect(await field.boundingBox()).toEqual(before);
  }
  await field.fill('Control+Shift+Space');
});

test('dialogs, reduced motion, narrow and coarse layouts work', async (
  { browser, page },
) => {
  await page.setViewportSize({ height: 760, width: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await skipOnboarding(page);
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  const overlayPage = await page.context().newPage();
  await overlayPage.emulateMedia({ reducedMotion: 'reduce' });
  await overlayPage.goto('/overlay.html');
  const transitionDuration = await overlayPage.locator('.wave i').first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.00001);
  await overlayPage.close();
  await page.screenshot({
    fullPage: true,
    path: 'artifacts/screenshots/home-narrow.png',
  });
  const touchContext = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 760, width: 640 },
  });
  const touchPage = await touchContext.newPage();
  await touchPage.goto('/');
  expect(await touchPage.evaluate(() => ({
    hover: matchMedia('(hover: none)').matches,
    pointer: matchMedia('(pointer: coarse)').matches,
  }))).toEqual({ hover: true, pointer: true });
  await skipOnboarding(touchPage);
  await touchPage.getByRole('button', { name: 'Dictionary' }).click();
  const touchAction = touchPage.locator('[aria-label="Edit TypeScript"]');
  await expect(touchAction).toHaveCSS('visibility', 'visible');
  await expect(touchAction).toHaveCSS('opacity', '1');
  await touchPage.screenshot({
    fullPage: true,
    path: 'artifacts/screenshots/dictionary-coarse-narrow.png',
  });
  await touchPage.getByRole('button', { name: 'History' }).click();
  const copyAction = touchPage.locator(
    '[aria-label="Copy transcript"]'
  ).first();
  await expect(copyAction).toHaveCSS('visibility', 'visible');
  await touchPage.screenshot({
    fullPage: true,
    path: 'artifacts/screenshots/history-coarse-narrow.png',
  });
  await touchContext.close();
});

test('mock scenarios cover retry cancellation and expiry', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);
  await openDevPanel(page);
  await page.getByRole('button', { name: 'Listening · silent' }).click();
  await page.getByRole('button', { name: 'Processing' }).click();
  await page.getByRole('button', { name: 'Complete error' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('radiogroup', { name: 'History status' })
    .getByRole('radio', { name: 'Failed' }).click();
  await expect(page.getByText(/Temporary recovery buffer · expires/).first())
    .toBeVisible();
  await page.getByRole('article').first().hover();
  await page.getByRole('button', { name: 'Retry transcription' }).first()
    .click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Expire recovery buffers' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('radiogroup', { name: 'History status' })
    .getByRole('radio', { name: 'Failed' }).click();
  await expect(page.getByText('Temporary recovery buffer expired').first())
    .toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry transcription' }))
    .toHaveCount(0);
});

test('History retry cannot interrupt an active listening run', async (
  { page },
) => {
  await page.goto('/');
  await skipOnboarding(page);
  await openDevPanel(page);
  await page.getByRole('button', { name: 'Listening · silent' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('radiogroup', { name: 'History status' })
    .getByRole('radio', { name: 'Failed' }).click();
  const failed = page.getByRole('article').first();
  await failed.hover();
  await expect(page.getByRole('button', { name: 'Retry transcription' }))
    .toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await expect(page.getByRole('img', { name: 'Microphone level' }))
    .toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel' }).click();
});
