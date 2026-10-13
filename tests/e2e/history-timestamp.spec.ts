import { expect, test } from '@playwright/test';

/** QA #59: at Text size Large the nowrap History timestamp must not touch the transcript. */
for (const width of [640, 1280, 1920]) {
  for (const size of ['small', 'default', 'large']) {
    test(`History timestamp keeps a gap at ${size} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await page.getByRole('button', { name: 'Skip' }).click();
      await page.evaluate((s) => { document.documentElement.dataset.textsize = s; }, size);
      await page.getByRole('button', { name: 'History', exact: true }).first().click();
      const rows = page.locator('.history-row');
      await expect(rows.first()).toBeVisible();
      // Widest realistic time, so the check doesn't depend on fixture clock values.
      await page.evaluate(() => {
        document.querySelector('.history-row .timestamp')!.textContent = '12:59 PM';
      });
      const gaps = await rows.evaluateAll((els) => els.map((row) => {
        const ts = row.querySelector('.timestamp')!;
        const range = document.createRange();
        range.selectNodeContents(ts);
        const text = range.getBoundingClientRect();
        const body = row.querySelector('.history-row__body')!.getBoundingClientRect();
        return body.left - text.right;
      }));
      console.log(`gap ${size} ${width}: min ${Math.min(...gaps).toFixed(1)}px`);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(12);
    });
  }
}
