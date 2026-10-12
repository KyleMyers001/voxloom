import { expect, test } from '@playwright/test';

// QA #44: every result fits the 248×40 result window (OVERLAY_RESULT_WIDTH) without clipping.
const texts = [
  'Copied. Press ⌘V to paste',
  'Copied. Press Ctrl+V to paste',
  'Maybe inserted · copied',
  'Maybe inserted · check field',
  'Not verified',
  'Couldn’t transcribe',
  'Couldn’t insert',
];

test('HUD result pills fit the 248px result window', async ({ page }) => {
  await page.setViewportSize({ height: 40, width: 248 });
  await page.goto('/overlay.html');
  for (const text of texts) {
    const width = await page.evaluate((t) => {
      const root = document.getElementById('root')!;
      root.innerHTML = `<div class="hud-result hud-result--unverified"><svg class="icon" width="14" height="14"></svg><span>${t}</span></div>`;
      return root.querySelector<HTMLElement>('.hud-result')!.getBoundingClientRect().width;
    }, text);
    expect(width, text).toBeLessThanOrEqual(248 - 8);
  }
});
