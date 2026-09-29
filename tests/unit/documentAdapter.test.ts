import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShortcutGesture } from '../../src/services/contracts';
import { createDocumentShortcutController } from
  '../../src/services/shortcut/documentAdapter';

function shortcutEvent(type: 'keydown' | 'keyup', repeat = false) {
  return new KeyboardEvent(type, {
    bubbles: true,
    code: 'Space',
    ctrlKey: true,
    key: ' ',
    repeat,
    shiftKey: true,
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('createDocumentShortcutController visibility / pagehide', () => {
  afterEach(() => {
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('resets partial hold on visibilitychange hidden (missed-keyup safety)', () => {
    vi.useFakeTimers();
    let now = 0;
    const gestures: ShortcutGesture[] = [];
    const controller = createDocumentShortcutController({
      clock: () => now,
      onGesture: (gesture) => gestures.push(gesture),
      shortcut: 'Ctrl + Shift + Space',
      target: document,
    });

    document.dispatchEvent(shortcutEvent('keydown'));
    now = 320;
    vi.advanceTimersByTime(320);
    expect(gestures).toEqual(['hold-start']);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(shortcutEvent('keyup'));
    expect(gestures).toEqual(['hold-start']);

    setVisibility('visible');
    now = 500;
    document.dispatchEvent(shortcutEvent('keydown'));
    vi.advanceTimersByTime(320);
    document.dispatchEvent(shortcutEvent('keyup'));
    expect(gestures).toEqual(['hold-start', 'hold-start', 'hold-finish']);

    controller.dispose();
  });

  it('resets partial hold on pagehide', () => {
    vi.useFakeTimers();
    let now = 0;
    const gestures: ShortcutGesture[] = [];
    const controller = createDocumentShortcutController({
      clock: () => now,
      onGesture: (gesture) => gestures.push(gesture),
      shortcut: 'Ctrl + Shift + Space',
      target: document,
    });

    document.dispatchEvent(shortcutEvent('keydown'));
    now = 320;
    vi.advanceTimersByTime(320);
    expect(gestures).toEqual(['hold-start']);

    window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(shortcutEvent('keyup'));
    expect(gestures).toEqual(['hold-start']);

    now = 700;
    document.dispatchEvent(shortcutEvent('keydown'));
    vi.advanceTimersByTime(320);
    document.dispatchEvent(shortcutEvent('keyup'));
    expect(gestures).toEqual(['hold-start', 'hold-start', 'hold-finish']);

    controller.dispose();
  });

  it('does not reset on visibilitychange when still visible', () => {
    vi.useFakeTimers();
    let now = 0;
    const gestures: ShortcutGesture[] = [];
    const controller = createDocumentShortcutController({
      clock: () => now,
      onGesture: (gesture) => gestures.push(gesture),
      shortcut: 'Ctrl + Shift + Space',
      target: document,
    });

    document.dispatchEvent(shortcutEvent('keydown'));
    now = 320;
    vi.advanceTimersByTime(320);
    expect(gestures).toEqual(['hold-start']);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(shortcutEvent('keyup'));
    expect(gestures).toEqual(['hold-start', 'hold-finish']);

    controller.dispose();
  });
});
