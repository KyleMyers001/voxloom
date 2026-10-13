import { expect, test } from '@playwright/test';

// BUS-50: with Reduce Motion on, the HUD has no looping animation.
const states = [
  '<div class="recording recording--overlay" data-waveform="processing"><div class="hud-transcribing"><i></i></div></div>',
  '<div class="recording recording--overlay" data-waveform="processing"><div class="wave"><i style="--h:6px"></i><i style="--h:10px"></i></div></div>',
];

test('HUD does not animate under prefers-reduced-motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ height: 40, width: 248 });
  await page.goto('/overlay.html');
  for (const html of states) {
    const running = await page.evaluate((markup) => {
      const root = document.getElementById('root')!;
      root.innerHTML = markup;
      return document.getAnimations().map((a) => (a as CSSAnimation).animationName ?? 'transition');
    }, html);
    expect(running, html).toEqual([]);
  }
});

test('HUD still pulses with motion allowed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ height: 40, width: 248 });
  await page.goto('/overlay.html');
  const running = await page.evaluate((markup) => {
    document.getElementById('root')!.innerHTML = markup;
    return document.getAnimations().length;
  }, states[0]);
  expect(running).toBeGreaterThan(0);
});
