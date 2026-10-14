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
  const controller = createNativeShortcutController({
    api, clock: () => 0, holdRelease, onGesture: () => undefined, onRegisterFailure, onSuspendFailure, scheduler,
  });
  return { api, controller, onRegisterFailure, onSuspendFailure };
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
});
