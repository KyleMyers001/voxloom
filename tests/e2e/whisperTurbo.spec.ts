import { expect, test } from '@playwright/test';

for (const width of [1120, 640]) {
  test(`mock-backed browser offers explicit English-first Turbo at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Set up later', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Models', exact: true }).click();
    const turbo = page.getByRole('radio', { name: /Whisper Large v3 Turbo \(English\)/ });
    await expect(turbo).not.toBeChecked();
    await expect(page.getByRole('radio', { name: /Whisper Base/ })).toBeChecked();
    const card = page.getByRole('listitem').filter({ has: turbo });
    await expect(card.getByText('1.62 GB', { exact: true })).toBeVisible();
    await expect(card.getByText('Larger download and higher memory use than Tiny or Base.')).toBeVisible();
    await turbo.check();
    await expect(card.getByText(/download required before dictating/)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Cancel download' })).toHaveCount(0);
    await expect(card.getByText('On disk', { exact: true })).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('whisper-turbo-models.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Browser mode uses its mock store; this does not download real weights.
    await card.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(card.getByText('On disk', { exact: true })).toBeVisible();
    await expect(turbo).toBeChecked();
  });
}
