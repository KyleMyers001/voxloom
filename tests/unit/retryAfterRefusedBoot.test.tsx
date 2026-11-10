// BUS-46 slice 3: a launch that refused the saved lone key keeps it saved with
// nothing active. Saving the same key again can't change the value, so
// Settings asks main to retry; that retry is a user save, so Accessibility
// is requested, and a grant makes the key active without a relaunch of the UI.
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';

const retry = vi.hoisted(() => ({ handler: null as null | ((s: string) => void) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../../src/services/shortcut/bindingEvents', () => ({
  emitShortcutBound: vi.fn(),
  listenShortcutRetry: async (handler: (s: string) => void) => {
    retry.handler = handler;
    return () => { retry.handler = null; };
  },
}));

import { useShortcutRegistration } from '../../src/app/useShortcutRegistration';
import type { Scheduler } from '../../src/services/contracts';
import type { LoneKeyApi } from '../../src/services/shortcut/loneKeyBridge';
import { createNativeShortcutController, type NativeShortcutController } from '../../src/services/shortcut/nativeRegistration';
import type { NativeShortcutApi } from '../../src/services/shortcut/tauriShortcutApi';

function harness() {
  const calls: string[] = [];
  let granted = false;
  const loneKey: LoneKeyApi = {
    async arm(token) {
      calls.push(`arm ${token}`);
      if (!granted) throw new Error('Accessibility permission is needed');
    },
    async disarm() { calls.push('disarm'); },
    async listen() { return () => undefined; },
    async requestAccess() { calls.push('requestAccess'); return granted; },
  };
  const api: NativeShortcutApi = {
    isAvailable: () => true,
    async register(hotkey) { calls.push(`register ${hotkey}`); },
    async unregister() {},
    async unregisterAll() {},
  };
  const scheduler: Scheduler = { clear: () => {}, set: () => 0 };
  const controller = createNativeShortcutController({ api, clock: () => 0, loneKey, onGesture: () => {}, scheduler });
  return { calls, controller, grant: () => { granted = true; } };
}

describe('saving the same lone key again after a refused launch', () => {
  it('boot never requests; the retry does, then arms once access is granted', async () => {
    const { calls, controller, grant } = harness();
    // Launch: the saved key is refused (no request: not a user action).
    const boot = await controller.setShortcut('F13');
    expect(boot.ok).toBe(false);
    expect(calls).toEqual(['arm F13']);

    const nativeRef = { current: controller } as MutableRefObject<NativeShortcutController | null>;
    const registeredRef = { current: null } as MutableRefObject<string | null>;
    const callbacksRef = { current: {} };
    renderHook(() => useShortcutRegistration('F13', nativeRef, registeredRef, callbacksRef, async () => true, true));
    await waitFor(() => expect(retry.handler).not.toBeNull());

    calls.length = 0;
    grant(); // the user allowed it in System Settings
    await act(async () => retry.handler!('F13'));
    expect(calls).toEqual(['requestAccess', 'arm F13']);
    expect(registeredRef.current).toBe('F13');
    expect(controller.activeHotkey()).toBe('F13');
  });

  it('a retry that is still refused reports it and stays inactive (request asked again)', async () => {
    const { calls, controller } = harness();
    await controller.setShortcut('F13');
    const nativeRef = { current: controller } as MutableRefObject<NativeShortcutController | null>;
    const registeredRef = { current: null } as MutableRefObject<string | null>;
    renderHook(() => useShortcutRegistration('F13', nativeRef, registeredRef, { current: {} }, async () => true, true));
    await waitFor(() => expect(retry.handler).not.toBeNull());
    calls.length = 0;
    await act(async () => retry.handler!('F13'));
    expect(calls).toEqual(['requestAccess', 'arm F13']);
    expect(registeredRef.current).toBeNull();
    expect(controller.activeHotkey()).toBeNull();
  });
});
