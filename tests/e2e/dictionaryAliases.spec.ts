import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/** BUS-138 PR B: the "Also heard as" field in the word dialog, in a browser. */
test('dictionary: aliases save, show in the list, reject a common word, and stay accessible', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Dictionary' }).click();
  await page.getByRole('button', { name: 'Add term' }).click();

  await page.getByRole('textbox', { name: 'Word' }).fill('Voxloom');
  const aliases = page.getByRole('textbox', { name: 'Also heard as (optional)' });
  await aliases.fill('sky');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'common word' })).toBeVisible();
  await expect(aliases).toHaveAttribute('aria-invalid', 'true');
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(({ impact }) => impact === 'critical' || impact === 'serious')).toEqual([]);

  await aliases.fill('box loom, voks loom');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Also heard as: box loom, voks loom')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'common word' })).toHaveCount(0);
});
