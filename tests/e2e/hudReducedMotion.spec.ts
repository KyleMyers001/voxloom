import { expect, test } from '@playwright/test';

// BUS-50: under Reduce Motion, transcribing keeps only the slow hud-breathe;
// the processing waveform has no animations. With motion allowed, the pulse runs.
const transcribing =
  '<div class="recording recording--overlay" data-waveform="processing"><div class="hud-transcribing"><i></i></div></div>';
const processingWave =
  '<div class="recording recording--overlay" data-waveform="processing"><div class="wave"><i style="--h:6px"></i><i style="--h:10px"></i></div></div>';

test('HUD under prefers-reduced-motion: breathe only on transcribing, none on processing waveform', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ height: 40, width: 248 });
  await page.goto('/overlay.html');

  const breathe = await page.evaluate((markup) => {
    document.getElementById('root')!.innerHTML = markup;
    return document.getAnimations().map((a) => (a as CSSAnimation).animationName ?? 'transition');
  }, transcribing);
  expect(breathe).toEqual(['hud-breathe']);

  const wave = await page.evaluate((markup) => {
    document.getElementById('root')!.innerHTML = markup;
    return document.getAnimations().map((a) => (a as CSSAnimation).animationName ?? 'transition');
  }, processingWave);
  expect(wave).toEqual([]);
});

test('HUD still pulses with motion allowed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ height: 40, width: 248 });
  await page.goto('/overlay.html');
  const running = await page.evaluate((markup) => {
    document.getElementById('root')!.innerHTML = markup;
    return document.getAnimations().map((a) => (a as CSSAnimation).animationName ?? 'transition');
  }, transcribing);
  expect(running).toContain('hud-pulse');
  expect(running.length).toBeGreaterThan(0);
});
