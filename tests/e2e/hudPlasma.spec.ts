import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __hud: {
      emit: (event: string, payload: unknown) => void;
      ready: () => boolean;
    };
  }
}

// Exercise the actual OverlayApp/React tree with the installed Tauri event API.
// Only its IPC boundary is mocked. No HTML replacement or live microphone.
async function openHud(page: Page) {
  await page.setViewportSize({ height: 76, width: 190 });
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 1;
    const w = window as unknown as Record<string, unknown>;
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: { event: string; handler: number; eventId: number }) => {
        if (command === 'plugin:event|listen') {
          const id = nextId++;
          listeners.set(id, { event: args.event, handler: args.handler });
          return id;
        }
        if (command === 'plugin:event|unlisten') listeners.delete(args.eventId);
        return null;
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => listeners.delete(id),
    };
    window.__hud = {
      emit: (event, payload) => {
        listeners.forEach((listener, id) => {
          if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
        });
      },
      ready: () => ['overlay:waveform', 'capture:event'].every((event) =>
        [...listeners.values()].some((listener) => listener.event === event)),
    };
  });
  await page.goto('/overlay.html');
  await expect.poll(() => page.evaluate(() => window.__hud.ready())).toBe(true);
  await expect(page.locator('.hud-plasma')).toBeVisible();
}

async function voice(page: Page, level: number) {
  await page.evaluate((value) => {
    window.__hud.emit('overlay:waveform', { waveform: 'speaking' });
    window.__hud.emit('capture:event', { generation: 1, kind: 'capture-started', request_id: 'plasma-fixture' });
    for (let i = 0; i < 24; i++) {
      window.__hud.emit('capture:event', { generation: 1, kind: 'capture-level', level: value, request_id: 'plasma-fixture' });
    }
  }, level);
}

test('Plasma: the original slim pill and three electric filaments fit the padded envelope', async ({ page }) => {
  await openHud(page);
  await voice(page, 1);
  const geometry = await page.locator('.hud-plasma').evaluate((svg) => {
    const bounds = svg.getBoundingClientRect();
    const pill = svg.parentElement!.getBoundingClientRect();
    const paths = [...svg.querySelectorAll('path')].map((path) => {
      const box = path.getBoundingClientRect();
      const stroke = Number.parseFloat(getComputedStyle(path).strokeWidth) / 2;
      return { bottom: box.bottom + stroke, left: box.left - stroke, right: box.right + stroke, top: box.top - stroke };
    });
    return {
      bounds: { height: bounds.height, width: bounds.width, x: bounds.x, y: bounds.y },
      filter: getComputedStyle(svg).filter,
      paths,
      pill: { height: pill.height, width: pill.width, x: pill.x, y: pill.y },
      pointerEvents: getComputedStyle(svg).pointerEvents,
    };
  });
  expect(geometry.bounds).toEqual({ height: 76, width: 190, x: 0, y: 0 });
  expect(geometry.pill).toEqual({ height: 22, width: 136, x: 27, y: 27 });
  expect(geometry.pointerEvents).toBe('none');
  expect(geometry.filter).toBe('none');
  for (const path of geometry.paths) {
    expect(path.left).toBeGreaterThan(0);
    expect(path.top).toBeGreaterThan(0);
    expect(path.right).toBeLessThan(190);
    expect(path.bottom).toBeLessThan(76);
  }
  await expect(page.getByRole('img', { name: 'Microphone level' }).locator('i')).toHaveCount(24);
  await expect(page.locator('.wave i').last()).toHaveCSS('height', '13px');
  await page.screenshot({ path: test.info().outputPath('plasma-loud.png'), omitBackground: true });
});

test('Plasma: real capture metadata increases energy, stale metadata cannot, silence resets it', async ({ page }) => {
  await openHud(page);
  const plasma = page.locator('.hud-plasma');
  const quiet = await plasma.evaluate((svg) => ({ opacity: Number(getComputedStyle(svg).opacity), path: svg.querySelector('path')!.getAttribute('d') }));
  await page.screenshot({ path: test.info().outputPath('plasma-quiet.png'), omitBackground: true });
  await voice(page, 1);
  await expect(page.locator('.wave i').last()).toHaveAttribute('style', '--h: 13px;');
  await expect.poll(() => plasma.evaluate((svg) => Number(getComputedStyle(svg).opacity))).toBeGreaterThan(quiet.opacity);
  const loud = await plasma.locator('path').first().getAttribute('d');
  expect(loud).not.toBe(quiet.path);
  await page.evaluate(() => window.__hud.emit('capture:event', { generation: 0, kind: 'capture-level', level: 0, request_id: 'stale' }));
  await expect(plasma.locator('path').first()).toHaveAttribute('d', loud!);
  await page.evaluate(() => window.__hud.emit('overlay:waveform', { waveform: 'silent' }));
  await expect(plasma.locator('path').first()).toHaveAttribute('d', quiet.path!);
  await expect(page.locator('.wave i').last()).toHaveAttribute('style', '--h: 1px;');
});

test('Plasma: changing Reduce Motion immediately removes all new motion and transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openHud(page);
  const plasma = page.locator('.hud-plasma');
  await expect.poll(() => plasma.evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => plasma.evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBe(0);
  await voice(page, 1);
  await expect.poll(() => plasma.evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(plasma).toHaveCSS('transition-duration', '0s');
  await expect(page.locator('.wave i').last()).toHaveCSS('transition-duration', '0s');
  await page.screenshot({ path: test.info().outputPath('plasma-reduced-motion.png'), omitBackground: true });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => plasma.evaluate((svg) => svg.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
});

test('Plasma: processing and all results remove the decoration but retain live announcements', async ({ page }) => {
  await openHud(page);
  const status = page.getByRole('status');
  await voice(page, 1);
  for (const state of [
    { spoken: 'Transcribing', waveform: 'processing' },
    { result: 'copied', spoken: 'Copied.', waveform: 'result-copied' },
    { result: 'maybe-copied', spoken: 'May have been inserted', waveform: 'result-unverified' },
    { result: 'insert-failed', spoken: 'Couldn’t insert', waveform: 'result-failed' },
    { result: 'transcribe-failed', spoken: 'Couldn’t transcribe', waveform: 'result-failed' },
  ]) {
    await page.evaluate((payload) => window.__hud.emit('overlay:waveform', payload), state);
    await expect(page.locator('.hud-plasma')).toHaveCount(0);
    await expect(status).toContainText(state.spoken);
    expect(await page.evaluate(() => document.getAnimations().some((animation) => animation instanceof CSSAnimation && animation.animationName.startsWith('plasma-')))).toBe(false);
    if (state.waveform === 'processing') await expect(page.locator('.hud-transcribing i')).toBeVisible();
  }
});
