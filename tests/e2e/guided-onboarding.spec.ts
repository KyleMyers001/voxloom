import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { join } from 'node:path';
import process from 'node:process';

for (const theme of ['dark', 'light']) for (const width of [640, 1000]) {
  test(`${theme} B spine and controls fit ${width}x620 with reduced motion`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 620 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const step of [0, 1, 2, 3, 4]) {
      await page.goto(`/tests/fixtures/guided-preview.html?step=${step}&theme=${theme}`);
      const panel = page.getByRole('main', { name: 'Set up Voxloom' });
      await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
      const rect = await panel.boundingBox();
      const filename = `guided-${theme}-${width}-step${step}-${process.env.VISUAL_PHASE ?? 'green'}.png`;
      await page.screenshot({ path: process.env.GUIDED_EVIDENCE_DIR ? join(process.env.GUIDED_EVIDENCE_DIR, filename) : testInfo.outputPath(filename) });
      // BUS-216: setup fills the whole window; no dialog or backdrop.
      expect(rect).toEqual({ x: 0, y: 0, width, height: 620 });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const footer = await page.locator('.guided-footer').boundingBox();
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(620);
      if (step === 0) {
        const disclosure = await page.getByText(/Starting setup downloads Whisper Base/).boundingBox();
        expect(disclosure!.y + disclosure!.height).toBeLessThanOrEqual(footer!.y);
      }
      if (step === 3) await expect(page.getByRole('status')).toHaveText('Ready when you are');
      expect(await page.locator('.guided-setup').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const violations = (await new AxeBuilder({ page }).include('.setup-window').analyze()).violations;
      expect(violations).toEqual([]);
      await page.keyboard.press('Shift+Tab');
      expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
  });
}
