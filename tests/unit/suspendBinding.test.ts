// BUS-69: suspendBinding must never silently lose the global shortcut.
import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../../src/services/contracts';
import type { HoldReleaseApi } from '../../src/services/shortcut/holdReleaseBridge';
import { createNativeShortcutController, type NativeShortcutApi } from '../../src/services/shortcut/nativeRegistration';

function setup() {
  const api = {
    isAvailable: () => true,
    register: vi.fn<NativeShortcutApi['register']>(async () => undefined),
    unregister: vi.fn<NativeShortcutApi['unregister']>(async () => undefined),
    unregisterAll: vi.fn<NativeShortcutApi['unregisterAll']>(async () => undefined),
  };
  const holdRelease: HoldReleaseApi = {
    arm: async () => true, disarm: async () => undefined, isAvailable: () => true, listen: async () => () => undefined,
  };
  const scheduler: Scheduler = { clear: () => undefined, set: () => 0 };
  const onRegisterFailure = vi.fn();
  const onSuspendFailure = vi.fn();
  const onSuspendRecovered = vi.fn();
  const gestures: string[] = [];
  let now = 0;
  const timers = new Map<number, () => void>();
  let id = 0;
  scheduler.set = (cb) => { id += 1; timers.set(id, cb); return id; };
  scheduler.clear = (t) => { timers.delete(t); };
  const flush = () => { for (const [t, cb] of [...timers]) { timers.delete(t); cb(); } };
  const edge = (e: 'pressed' | 'released') => {
    const calls = api.register.mock.calls;
    calls[calls.length - 1][1](e);
  };
  const controller = createNativeShortcutController({
    api, clock: () => now, doubleTapMs: 100, holdMs: 10, holdRelease,
    onGesture: (g) => { gestures.push(g); }, onRegisterFailure, onSuspendFailure, onSuspendRecovered, scheduler,
  });
  return {
    advance: (ms: number) => { now += ms; }, api, controller, edge, flush, gestures,
    onRegisterFailure, onSuspendFailure, onSuspendRecovered,
  };
}

describe('suspendBinding (BUS-69)', () => {
  it('double suspend unregisters once and resume re-binds once', async () => {
    const { api, controller } = setup();
    await controller.setShortcut('Shift + Space');
    const hotkey = controller.activeHotkey();
    api.register.mockClear();
    await controller.suspendBinding(true);
    await controller.suspendBinding(true);
    expect(api.unregister).toHaveBeenCalledTimes(1);
    expect(controller.activeHotkey()).toBeNull();
    await controller.suspendBinding(false);
    await controller.suspendBinding(false);
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(controller.activeHotkey()).toBe(hotkey);
  });

  it('retries a failed re-bind once and succeeds silently', async () => {
    const { api, controller, onSuspendFailure } = setup();
    await controller.setShortcut('Shift + Space');
    const hotkey = controller.activeHotkey();
    await controller.suspendBinding(true);
    api.register.mockRejectedValueOnce(new Error('busy'));
    await controller.suspendBinding(false);
    expect(controller.activeHotkey()).toBe(hotkey);
    expect(onSuspendFailure).not.toHaveBeenCalled();
  });

  it('reports a re-bind that fails twice and keeps the hotkey for the next resume', async () => {
    const { api, controller, onRegisterFailure, onSuspendFailure } = setup();
    await controller.setShortcut('Shift + Space');
    const hotkey = controller.activeHotkey();
    await controller.suspendBinding(true);
    api.register.mockClear();
    api.register.mockRejectedValue(new Error('taken'));
    await controller.suspendBinding(false);
    expect(api.register).toHaveBeenCalledTimes(2);
    expect(controller.activeHotkey()).toBeNull();
    expect(onRegisterFailure).toHaveBeenCalledWith('taken');
    expect(onSuspendFailure).toHaveBeenCalledWith('rebind', 'taken');
    api.register.mockResolvedValue(undefined);
    await controller.suspendBinding(true);
    await controller.suspendBinding(false);
    expect(controller.activeHotkey()).toBe(hotkey);
  });

  it('does not mark the hotkey suspended when unregister fails, and reports it', async () => {
    const { api, controller, onSuspendFailure } = setup();
    await controller.setShortcut('Shift + Space');
    const hotkey = controller.activeHotkey();
    api.unregister.mockRejectedValueOnce(new Error('native'));
    api.register.mockClear();
    await controller.suspendBinding(true);
    expect(onSuspendFailure).toHaveBeenCalledWith('unbind', 'native');
    expect(controller.activeHotkey()).toBe(hotkey);
    await controller.suspendBinding(false);
    expect(api.register).not.toHaveBeenCalled();
    expect(controller.activeHotkey()).toBe(hotkey);
  });

  it('finishes a latched dictation before unbinding', async () => {
    const { advance, controller, edge, gestures } = setup();
    await controller.setShortcut('Shift + Space');
    edge('pressed'); edge('released'); advance(20);
    edge('pressed'); edge('released');
    expect(gestures).toEqual(['latch-start']);
    await controller.suspendBinding(true);
    expect(gestures).toEqual(['latch-start', 'latch-finish']);
    await controller.suspendBinding(false);
    // Fresh state after resume: one tap does not "finish" anything.
    advance(500); edge('pressed'); edge('released');
    expect(gestures).toEqual(['latch-start', 'latch-finish']);
  });

  it('finishes an active hold before unbinding', async () => {
    const { controller, edge, flush, gestures } = setup();
    await controller.setShortcut('Shift + Space');
    edge('pressed'); flush();
    expect(gestures).toEqual(['hold-start']);
    await controller.suspendBinding(true);
    expect(gestures).toEqual(['hold-start', 'hold-finish']);
  });

  it('keeps an active latch when unbind fails', async () => {
    const { advance, api, controller, edge, gestures } = setup();
    await controller.setShortcut('Shift + Space');
    edge('pressed'); edge('released'); advance(20);
    edge('pressed'); edge('released');
    api.unregister.mockRejectedValueOnce(new Error('native'));
    await controller.suspendBinding(true);
    expect(gestures).toEqual(['latch-start']);
    edge('pressed');
    expect(gestures).toEqual(['latch-start', 'latch-finish']);
  });

  it('reports recovery when a later resume re-binds after a failure', async () => {
    const { api, controller, onSuspendFailure, onSuspendRecovered } = setup();
    await controller.setShortcut('Shift + Space');
    await controller.suspendBinding(true);
    api.register.mockRejectedValue(new Error('taken'));
    await controller.suspendBinding(false);
    expect(onSuspendFailure).toHaveBeenCalledWith('rebind', 'taken');
    expect(onSuspendRecovered).not.toHaveBeenCalled();
    api.register.mockResolvedValue(undefined);
    await controller.suspendBinding(true);
    await controller.suspendBinding(false);
    expect(onSuspendRecovered).toHaveBeenCalledTimes(1);
    await controller.suspendBinding(true);
    await controller.suspendBinding(false);
    expect(onSuspendRecovered).toHaveBeenCalledTimes(1);
  });

  it('clears the stale suspended combo when setShortcut succeeds outside recording', async () => {
    const { api, controller, onSuspendRecovered } = setup();
    await controller.setShortcut('Shift + Space');
    await controller.suspendBinding(true);
    api.register.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x'));
    await controller.suspendBinding(false);
    expect(controller.activeHotkey()).toBeNull();
    await controller.setShortcut('Ctrl + Shift + D');
    const saved = controller.activeHotkey();
    expect(saved).not.toBeNull();
    api.register.mockClear();
    await controller.suspendBinding(true);
    await controller.suspendBinding(false);
    // Re-binds the saved combo, not the stale Shift+Space; no recovery report.
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.register.mock.calls[0][0]).toBe(saved);
    expect(onSuspendRecovered).not.toHaveBeenCalled();
  });
});
