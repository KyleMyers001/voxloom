// BUS-46 slice 3: a lone key drives the same gesture machine as a combo, through
// the native listener. Fakes stand in for the plugin and the Tauri bridge.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scheduler, ShortcutGesture } from '../../src/services/contracts';
import type { HoldReleaseApi } from '../../src/services/shortcut/holdReleaseBridge';
import type { LoneKeyApi, LoneKeyEdge } from '../../src/services/shortcut/loneKeyBridge';
import { createNativeShortcutController, type NativeShortcutApi } from '../../src/services/shortcut/nativeRegistration';
import { beginRecordingSuspend, resetRecordingSuspend } from '../../src/services/shortcut/recordingSuspend';

afterEach(() => resetRecordingSuspend());

function setup(opts: { armError?: string } = {}) {
  const calls: string[] = [];
  const gestures: ShortcutGesture[] = [];
  let pluginEdge: ((edge: 'pressed' | 'released') => void) | null = null;
  let loneEdge: ((edge: LoneKeyEdge) => void) | null = null;
  const api: NativeShortcutApi = {
    isAvailable: () => true,
    async register(hotkey, edge) { calls.push(`register ${hotkey}`); pluginEdge = edge; },
    async unregister(hotkey) { calls.push(`unregister ${hotkey}`); },
    async unregisterAll() { calls.push('unregisterAll'); },
  };
  const loneKey: LoneKeyApi = {
    async arm(token) {
      calls.push(`arm ${token}`);
      if (opts.armError) throw new Error(opts.armError);
    },
    async disarm() { calls.push('disarm'); },
    async listen(onEdge) { loneEdge = onEdge; return () => { loneEdge = null; }; },
  };
  const holdArm = vi.fn(async () => true);
  const holdRelease: HoldReleaseApi = {
    arm: holdArm, disarm: async () => undefined, isAvailable: () => true, listen: async () => () => undefined,
  };
  let now = 0;
  let timer = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const scheduler: Scheduler = {
    clear: (id) => { timers.delete(id); },
    set: (cb, delay) => { timer += 1; timers.set(timer, { at: now + delay, cb }); return timer; },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.cb(); }
  };
  const controller = createNativeShortcutController({
    api, clock: () => now, holdRelease, loneKey, onGesture: (g) => gestures.push(g), scheduler,
  });
  return {
    advance, calls, controller, gestures, holdArm,
    lone: (edge: LoneKeyEdge) => loneEdge!(edge),
    plugin: (edge: 'pressed' | 'released') => pluginEdge!(edge),
    listening: () => loneEdge !== null,
    ready: () => Promise.resolve(),
  };
}

describe('a lone key as the shortcut', () => {
  it('is armed natively and never sent to the plugin', async () => {
    const t = setup();
    const outcome = await t.controller.setShortcut('AltRight');
    expect(outcome).toMatchObject({ active: 'AltRight', ok: true });
    expect(t.calls).toEqual(['arm AltRight']);
    expect(t.controller.activeHotkey()).toBe('AltRight');
  });

  it('arms a hand-edited lowercase token as the canonical one', async () => {
    const t = setup();
    await t.controller.setShortcut('f13');
    expect(t.calls).toEqual(['arm F13']);
  });

  it('combo to lone key: the combo is unregistered before the tap is armed', async () => {
    const t = setup();
    await t.controller.setShortcut('Ctrl + Shift + Space');
    t.calls.length = 0;
    await t.controller.setShortcut('AltRight');
    expect(t.calls).toEqual(['unregister Control+Shift+Space', 'arm AltRight']);
  });

  it('lone key to combo: the tap is disarmed before the combo is registered', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    t.calls.length = 0;
    await t.controller.setShortcut('Ctrl + Shift + Space');
    expect(t.calls).toEqual(['disarm', 'register Control+Shift+Space']);
    expect(t.controller.activeHotkey()).toBe('Control+Shift+Space');
  });

  it('lone key to another lone key re-arms once, with a disarm first', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    t.calls.length = 0;
    await t.controller.setShortcut('F13');
    expect(t.calls).toEqual(['disarm', 'arm F13']);
  });

  it('a refusal (no Input Monitoring) puts the previous combo back', async () => {
    const t = setup({ armError: 'Input Monitoring permission is needed' });
    await t.controller.setShortcut('Ctrl + Shift + Space');
    t.calls.length = 0;
    const outcome = await t.controller.setShortcut('AltRight');
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ active: 'Control+Shift+Space' });
    expect(t.calls).toEqual(['unregister Control+Shift+Space', 'arm AltRight', 'register Control+Shift+Space']);
    expect(t.controller.activeHotkey()).toBe('Control+Shift+Space');
  });

  it('pressed and released make a hold, with no hold-release watch', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    t.lone('pressed');
    t.advance(320);
    expect(t.gestures).toEqual(['hold-start']);
    t.lone('released');
    expect(t.gestures).toEqual(['hold-start', 'hold-finish']);
    expect(t.holdArm).not.toHaveBeenCalled();
  });

  it('two quick taps latch; a third press ends the latch', async () => {
    const t = setup();
    await t.controller.setShortcut('F13');
    t.lone('pressed'); t.lone('released');
    t.advance(100);
    t.lone('pressed'); t.lone('released');
    expect(t.gestures).toEqual(['latch-start']);
    t.lone('pressed'); t.lone('released');
    expect(t.gestures).toEqual(['latch-start', 'latch-finish']);
  });

  it('cancelled clears a half-finished double-tap', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    t.lone('pressed'); t.lone('released');
    t.lone('cancelled');
    t.advance(100);
    t.lone('pressed'); t.lone('released');
    expect(t.gestures).toEqual([]);
  });

  it('cancelled after a hold leaves the finish already given', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    t.lone('pressed');
    t.advance(320);
    t.lone('released');
    t.lone('cancelled');
    expect(t.gestures).toEqual(['hold-start', 'hold-finish']);
  });

  it('ignores edges while a combo, or nothing, is the shortcut', async () => {
    const t = setup();
    await t.controller.setShortcut('Ctrl + Shift + Space');
    t.lone('pressed');
    t.advance(320);
    expect(t.gestures).toEqual([]);
    await t.controller.suspendBinding(true);
    t.lone('pressed');
    t.advance(320);
    expect(t.gestures).toEqual([]);
  });

  it('combo edges still work after a lone key was used and dropped', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    await t.controller.setShortcut('Ctrl + Shift + Space');
    t.plugin('pressed');
    t.advance(320);
    expect(t.gestures).toEqual(['hold-start']);
    t.plugin('released');
    await t.ready();
  });

  it('a recorder disarms the tap while recording and re-arms it after', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    t.calls.length = 0;
    await t.controller.suspendBinding(true);
    expect(t.calls).toEqual(['disarm']);
    expect(t.controller.activeHotkey()).toBeNull();
    await t.controller.suspendBinding(false);
    expect(t.calls).toEqual(['disarm', 'arm AltRight']);
    expect(t.controller.activeHotkey()).toBe('AltRight');
  });

  it('a hold-start while a recorder records is dropped without arming a watch', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    const end = beginRecordingSuspend();
    t.lone('pressed');
    t.advance(320);
    expect(t.holdArm).not.toHaveBeenCalled();
    end();
  });

  it('dispose disarms the tap and stops listening', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    t.calls.length = 0;
    await t.controller.dispose();
    expect(t.calls).toEqual(['disarm']);
    expect(t.listening()).toBe(false);
  });
});
