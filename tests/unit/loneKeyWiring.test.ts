// BUS-46 slice 3: a lone key drives the same gesture machine as a combo, through
// the native listener. Fakes stand in for the plugin and the Tauri bridge.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scheduler, ShortcutGesture } from '../../src/services/contracts';
import type { HoldReleaseApi } from '../../src/services/shortcut/holdReleaseBridge';
import type { LoneKeyApi, LoneKeyEdge } from '../../src/services/shortcut/loneKeyBridge';
import { createNativeShortcutController, type NativeShortcutApi } from '../../src/services/shortcut/nativeRegistration';
import { beginRecordingSuspend, resetRecordingSuspend } from '../../src/services/shortcut/recordingSuspend';

afterEach(() => resetRecordingSuspend());

function setup(opts: {
  armError?: string | ((token: string) => string | undefined);
  granted?: boolean;
  registerGate?: () => Promise<void>;
  requestThrows?: boolean;
} = {}) {
  const calls: string[] = [];
  const gestures: ShortcutGesture[] = [];
  let pluginEdge: ((edge: 'pressed' | 'released') => void) | null = null;
  let loneEdge: ((edge: LoneKeyEdge) => void) | null = null;
  const api: NativeShortcutApi = {
    isAvailable: () => true,
    async register(hotkey, edge) {
      calls.push(`register ${hotkey}`);
      pluginEdge = edge;
      await opts.registerGate?.();
    },
    async unregister(hotkey) { calls.push(`unregister ${hotkey}`); },
    async unregisterAll() { calls.push('unregisterAll'); },
  };
  const loneKey: LoneKeyApi = {
    async arm(token) {
      calls.push(`arm ${token}`);
      const error = typeof opts.armError === 'function' ? opts.armError(token) : opts.armError;
      if (error) throw new Error(error);
    },
    async requestAccess() {
      calls.push('requestAccess');
      if (opts.requestThrows) throw new Error('boom');
      return opts.granted ?? false;
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
  const lost: string[] = [];
  const controller = createNativeShortcutController({
    api, clock: () => now, holdRelease, loneKey, onBindingLost: (m) => lost.push(m),
    onGesture: (g) => gestures.push(g), scheduler,
  });
  return {
    advance, calls, controller, gestures, holdArm, lost,
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

  it('a refusal (no Accessibility) puts the previous combo back', async () => {
    const t = setup({ armError: 'Accessibility permission is needed' });
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

  it('cancelled on the second press of a double-tap finishes the latch it started', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    t.lone('pressed'); t.lone('released');
    t.advance(100);
    t.lone('pressed'); // latch-start: dictation is running
    t.lone('released'); t.lone('cancelled'); // a chord key joined that press
    expect(t.gestures).toEqual(['latch-start', 'latch-finish']);
    t.lone('pressed'); t.lone('released'); // the next tap must not think it is a latch
    expect(t.gestures).toEqual(['latch-start', 'latch-finish']);
  });

  it('access-lost (BUS-209) finishes a hold and leaves nothing active until a save', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    t.lone('pressed');
    t.advance(320);
    t.lone('access-lost'); // native already sent released + cancelled, maybe lost
    expect(t.gestures).toEqual(['hold-start', 'hold-finish']);
    expect(t.controller.activeHotkey()).toBeNull();
    expect(t.lost).toHaveLength(1);
    t.lone('pressed');
    t.advance(320);
    expect(t.gestures).toEqual(['hold-start', 'hold-finish']);
    t.calls.length = 0;
    await t.controller.setShortcut('AltRight', { userInitiated: true });
    expect(t.calls).toEqual(['requestAccess', 'arm AltRight']);
    expect(t.controller.activeHotkey()).toBe('AltRight');
  });

  it('access-lost while a combo is registering does not kill the new combo', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const t = setup({ registerGate: () => gate });
    await t.controller.setShortcut('AltRight');
    const pending = t.controller.setShortcut('Ctrl + Shift + Space');
    await vi.waitFor(() => expect(t.calls).toContain('register Control+Shift+Space'));
    t.lone('access-lost'); // the lone key is still active until register resolves
    expect(t.lost).toHaveLength(1);
    open();
    await expect(pending).resolves.toMatchObject({ active: 'Control+Shift+Space', ok: true });
    t.plugin('pressed');
    t.advance(320);
    expect(t.gestures).toEqual(['hold-start']);
  });

  it('a late access-lost is ignored once a combo is the shortcut', async () => {
    const t = setup();
    await t.controller.setShortcut('AltRight');
    await t.controller.setShortcut('Ctrl + Shift + Space');
    t.lone('access-lost');
    expect(t.controller.activeHotkey()).toBe('Control+Shift+Space');
    expect(t.lost).toEqual([]);
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

  describe('Accessibility request', () => {
    it('is asked for once, before arming, when the user saves a lone key', async () => {
      const t = setup();
      await t.controller.setShortcut('AltRight', { userInitiated: true });
      expect(t.calls).toEqual(['requestAccess', 'arm AltRight']);
    });

    it('is not asked for at boot (no user action)', async () => {
      const t = setup();
      await t.controller.setShortcut('AltRight');
      await t.controller.setShortcut('F13', { userInitiated: false });
      expect(t.calls).not.toContain('requestAccess');
    });

    it('is not asked for when a combo is saved, or the lone key is already active', async () => {
      const t = setup();
      await t.controller.setShortcut('Ctrl + Shift + Space', { userInitiated: true });
      await t.controller.setShortcut('AltRight', { userInitiated: true });
      t.calls.length = 0;
      await t.controller.setShortcut('AltRight', { userInitiated: true });
      expect(t.calls).toEqual([]);
      await t.controller.setShortcut('Ctrl + Shift + Space', { userInitiated: true });
      expect(t.calls.filter((c) => c === 'requestAccess')).toEqual([]);
    });

    it('is not asked for again when a refused save restores the previous lone key', async () => {
      const t = setup({ armError: (token) => (token === 'F13' ? 'Accessibility permission is needed' : undefined) });
      await t.controller.setShortcut('AltRight');
      t.calls.length = 0;
      const outcome = await t.controller.setShortcut('F13', { userInitiated: true });
      expect(outcome).toMatchObject({ active: 'AltRight', ok: false });
      expect(t.calls.filter((c) => c === 'requestAccess')).toHaveLength(1);
    });

    it('still arms (and reports the refusal) when the request says not yet', async () => {
      const t = setup({ armError: 'Accessibility permission is needed', granted: false });
      const outcome = await t.controller.setShortcut('F13', { userInitiated: true });
      expect(t.calls).toEqual(['requestAccess', 'arm F13']);
      expect(outcome).toMatchObject({ ok: false });
    });

    it('survives a request that throws', async () => {
      const t = setup({ requestThrows: true });
      const outcome = await t.controller.setShortcut('AltRight', { userInitiated: true });
      expect(t.calls).toEqual(['requestAccess', 'arm AltRight']);
      expect(outcome).toMatchObject({ active: 'AltRight', ok: true });
    });
  });
});
