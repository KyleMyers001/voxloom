import { expect, test, type Page } from '@playwright/test';

// Only the Tauri event transport is stubbed; OverlayApp, levels mapping and React
// rendering are real. No microphone, native window or raw audio is used.
async function mountOverlay(page: Page) {
  await page.setViewportSize({ height: 76, width: 190 });
  await page.addInitScript(() => {
    type Handler = (event: { event: string; id: number; payload: unknown }) => void;
    const callbacks = new Map<number, Handler>();
    const listeners = new Map<string, Set<number>>();
    let next = 0;
    const w = window as unknown as Record<string, unknown>;
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: Handler) => { callbacks.set(++next, callback); return next; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: { event: string; handler: number; eventId: number }) => {
        if (command === 'plugin:event|listen') {
          if (!listeners.has(args.event)) listeners.set(args.event, new Set());
          listeners.get(args.event)!.add(args.handler);
          return args.handler;
        }
        if (command === 'plugin:event|unlisten') listeners.get(args.event)?.delete(args.eventId);
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__resonanceEmit = (event: string, payload: unknown) => {
      const ids = listeners.get(event);
      if (!ids?.size) throw new Error(`No listener: ${event}`);
      ids.forEach((id) => callbacks.get(id)!({ event, id, payload }));
    };
    w.__resonanceReady = () => !!listeners.get('capture:event')?.size && !!listeners.get('overlay:waveform')?.size;
  });
  await page.goto('/overlay.html');
  await page.waitForFunction(() => (window as unknown as { __resonanceReady: () => boolean }).__resonanceReady());
}

async function emit(page: Page, event: string, payload: unknown) {
  await page.evaluate(({ event, payload }) => {
    (window as unknown as { __resonanceEmit: (event: string, payload: unknown) => void }).__resonanceEmit(event, payload);
  }, { event, payload });
}

async function level(page: Page, value: number) {
  await emit(page, 'capture:event', { generation: 1, kind: 'capture-level', level: value, request_id: 'resonance-test' });
}

async function speak(page: Page) {
  await emit(page, 'overlay:waveform', { waveform: 'speaking' });
  await emit(page, 'capture:event', { generation: 1, kind: 'capture-started', request_id: 'resonance-test' });
  await level(page, 0.25);
}

test('mounted listening ripples react to levels, remain capsule-sized and leave processing/results untouched', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mountOverlay(page);
  const decoration = page.locator('.hud-resonance');
  await expect(decoration).toHaveAttribute('aria-hidden', 'true');
  await speak(page);
  await expect(decoration).toHaveCSS('pointer-events', 'none');
  await expect(decoration).toHaveCSS('opacity', '0.42');
  await expect(page.locator('.wave i')).toHaveCount(24);
  const geometry = await page.locator('.hud-resonance__ripple').evaluateAll((ripples) => ripples.map((ripple) => {
    const animation = ripple.getAnimations()[0];
    animation.pause();
    animation.currentTime = 1500;
    const rect = ripple.getBoundingClientRect();
    return { animation: (animation as CSSAnimation).animationName, bottom: rect.bottom, height: rect.height, left: rect.left, pointer: getComputedStyle(ripple).pointerEvents, right: rect.right, top: rect.top, width: rect.width };
  }));
  for (const rect of geometry) {
    expect(rect.animation).toBe('hud-resonance-ripple');
    expect(rect.pointer).toBe('none');
    expect(rect.left).toBeGreaterThan(0);
    expect(rect.top).toBeGreaterThan(0);
    expect(rect.right).toBeLessThan(190);
    expect(rect.bottom).toBeLessThan(76);
    expect(rect.width / rect.height).toBeGreaterThan(2.5);
  }
  const pill = await page.locator('.recording--overlay').boundingBox();
  expect(pill?.width).toBe(136);
  expect(pill?.height).toBe(22);
  expect(pill?.y).toBe(27);
  await page.screenshot({ path: testInfo.outputPath('resonance-speaking.png') });
  await level(page, 0.02);
  await expect.poll(async () => Number(await decoration.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.42);
  await level(page, 0);
  await expect(decoration).toHaveCSS('opacity', '0');
  await level(page, 0.25);
  await expect(decoration).toHaveCSS('opacity', '0.42');
  await emit(page, 'overlay:waveform', { waveform: 'silent' });
  await expect(decoration).toHaveCSS('opacity', '0');
  await emit(page, 'overlay:waveform', { waveform: 'processing' });
  await expect(decoration).toHaveCount(0);
  await expect(page.locator('.hud-transcribing')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Transcribing');
  await emit(page, 'overlay:waveform', { result: 'copied', waveform: 'result-copied' });
  await expect(decoration).toHaveCount(0);
  await expect(page.locator('.hud-result')).toContainText('Copied');
});

test('reduced motion removes all new animations/transitions and keeps a static subtle rim', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mountOverlay(page);
  await speak(page);
  const layers = page.locator('.hud-resonance, .hud-resonance *');
  const initial = await layers.evaluateAll((els) => els.map((el) => {
    const style = getComputedStyle(el);
    return { animation: style.animationName, duration: style.transitionDuration };
  }));
  for (const layer of initial) {
    expect(layer.animation).toBe('none');
    expect(layer.duration).toBe('0s');
  }
  const rim = page.locator('.hud-resonance__rim');
  await expect(rim).toHaveCSS('opacity', '0.22');
  await expect(page.locator('.hud-resonance__ripple').first()).toHaveCSS('opacity', '0');
  const before = await rim.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, transform: getComputedStyle(el).transform }));
  await level(page, 0);
  await page.waitForTimeout(150);
  expect(await rim.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, transform: getComputedStyle(el).transform }))).toEqual(before);
  expect(await layers.evaluateAll((els) => els.flatMap((el) => el.getAnimations()).length)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('resonance-reduced-motion.png') });
});
