import { expect, test } from '@playwright/test';

/**
 * QA #59: at every text size the nowrap timestamp must keep a >=12px gap to the
 * transcript (History and Home Recent, wide and narrow), and transcript starts
 * must line up across rows whatever the hour's digit count.
 */
const screens = [
  { name: 'History', nav: 'History', row: '.history-row', body: '.history-row__body' },
  { name: 'Home', nav: 'Home', row: '.home .recent-row', body: 'p' },
];

for (const screen of screens) {
  for (const width of [640, 760, 1280, 1440, 1920]) {
    for (const size of ['small', 'default', 'large']) {
      test(`${screen.name} timestamp gap + alignment at ${size} ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await page.getByRole('button', { name: 'Skip' }).click();
        await page.evaluate((s) => { document.documentElement.dataset.textsize = s; }, size);
        await page.getByRole('button', { name: screen.nav, exact: true }).first().click();
        const rows = page.locator(screen.row);
        await expect(rows.first()).toBeVisible();
        expect(await rows.count()).toBeGreaterThanOrEqual(2);
        // Widest and a narrow realistic time, so results don't depend on fixture clocks.
        await rows.evaluateAll((els) => els.forEach((row, i) => {
          row.querySelector('.timestamp')!.textContent = i % 2 === 0 ? '12:59\u202fPM' : '9:05\u202fAM';
        }));
        const m = await rows.evaluateAll((els, bodySel) => els.map((row) => {
          const range = document.createRange();
          range.selectNodeContents(row.querySelector('.timestamp')!);
          const text = range.getBoundingClientRect();
          const body = row.querySelector(bodySel)!.getBoundingClientRect();
          return { gap: body.left - text.right, left: body.left };
        }), screen.body);
        const gaps = m.map((r) => r.gap);
        const lefts = m.map((r) => r.left);
        const spread = Math.max(...lefts) - Math.min(...lefts);
        console.log(`${screen.name} ${size} ${width}: min gap ${Math.min(...gaps).toFixed(1)}px, spread ${spread.toFixed(1)}px`);
        for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(12);
        expect(spread).toBeLessThanOrEqual(0.5);
      });
    }
  }
}
