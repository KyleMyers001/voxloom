import { expect, test } from '@playwright/test';

// This checks the shipped browser bundle, not native microphone/TCC acceptance.
test('release setup cannot be passed by simulated gestures without macOS capture', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Development scenarios')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Simulate|Test hold|Test double-tap/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Start setup/ })).toBeDisabled();
  await expect(page.getByText(/Starting setup downloads Whisper Base/)).toBeVisible();
  await page.keyboard.press('Control+Shift+Space');
  await page.keyboard.press('Control+Shift+Space');
  await expect(page.getByRole('button', { name: /Finish setup/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Set up later' }).click();
  await expect(page.getByText(/Setup is incomplete/)).toBeVisible();
  await page.getByRole('button', { name: 'Resume setup' }).click();
  await expect(page.getByRole('main', { name: 'Set up Voxloom' })).toBeVisible();
});
