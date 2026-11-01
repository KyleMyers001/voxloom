// BUS-46 L4: a saved shortcut that native refuses at boot (a lone key without
// Input Monitoring, a combo another app holds) must stay saved. Binding the
// default first, before settings loaded, made the refusal rewrite the settings
// file with the default.
import { act, renderHook, waitFor } from '@testing-library/react';
import { isTauri } from '@tauri-apps/api/core';
import type { MutableRefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../src/app/initialState';
import { useShortcutGestures } from '../../src/app/useShortcutGestures';
import { useShortcutRegistration } from '../../src/app/useShortcutRegistration';
import type { NativeShortcutController, RegisterOutcome } from '../../src/services/shortcut';

const mocks = vi.hoisted(() => ({ controller: vi.fn(), overlay: vi.fn() }));

vi.mock('../../src/services/shortcut', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/shortcut')>();
  return {
    ...actual,
    createNativeShortcutController: () => mocks.controller(),
    createOverlayBridge: () => mocks.overlay(),
  };
});

const SAVED = 'AltRight';
const refused: RegisterOutcome = {
  active: null, attempted: SAVED, lastKnownGood: null, message: 'Input Monitoring', ok: false,
};

function fakeController(outcome: RegisterOutcome) {
  return {
    activeHotkey: vi.fn(() => null),
    dispose: vi.fn().mockResolvedValue(undefined),
    lastKnownGood: vi.fn(() => null),
    resetPartial: vi.fn(),
    setContext: vi.fn(),
    setShortcut: vi.fn<(s: string) => Promise<RegisterOutcome>>().mockResolvedValue(outcome),
    suspendBinding: vi.fn().mockResolvedValue(undefined),
  };
}

const now = () => 0; // stable: a new clock rebuilds the controller

function options(shortcut: string, bootReady: boolean, extra: { error?: (m: string) => void; revert?: (s: string) => void } = {}) {
  const base = createInitialState(0);
  return {
    bootReady,
    dictation: { cancel: vi.fn() } as never,
    dogfood: { cancel: vi.fn(), phase: 'idle', scopeReady: true, start: vi.fn(), stop: vi.fn() } as never,
    now,
    onboardingOpen: false,
    onShortcutError: extra.error ?? vi.fn(),
    onShortcutRevert: extra.revert ?? vi.fn(),
    setup: {} as never,
    shortcutOpen: false,
    state: { ...base, settings: { ...base.settings, shortcut } },
  };
}

describe('boot binding waits for the saved shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
    mocks.overlay.mockReturnValue({
      dispose: vi.fn().mockResolvedValue(undefined),
      showResult: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('binds nothing before settings load, then only the saved shortcut', async () => {
    const native = fakeController({ active: SAVED, lastKnownGood: SAVED, ok: true });
    mocks.controller.mockReturnValue(native);
    const defaults = createInitialState(0).settings.shortcut;
    const { rerender, unmount } = renderHook((p) => useShortcutGestures(p), {
      initialProps: options(defaults, false),
    });
    await act(async () => { await Promise.resolve(); });
    expect(native.setShortcut).not.toHaveBeenCalled();
    rerender(options(SAVED, true));
    await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(1));
    expect(native.setShortcut).toHaveBeenCalledWith(SAVED);
    unmount();
  });

  it('a refused saved lone key stays saved: no revert to the default, a toast says why', async () => {
    const native = fakeController(refused);
    mocks.controller.mockReturnValue(native);
    const errors: string[] = [];
    const revert = vi.fn();
    const defaults = createInitialState(0).settings.shortcut;
    const extra = { error: (m: string) => { errors.push(m); }, revert };
    const { rerender, unmount } = renderHook((p) => useShortcutGestures(p), {
      initialProps: options(defaults, false, extra),
    });
    rerender(options(SAVED, true, extra));
    await waitFor(() => expect(errors).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(native.setShortcut.mock.calls).toEqual([[SAVED]]);
    expect(revert).not.toHaveBeenCalled();
    expect(errors[0]).toMatch(/No shortcut is active\. Record one in Settings\.$/);
    expect(errors[0]).toMatch(/Input Monitoring|only works on macOS/);
    unmount();
  });

  it('a change after boot is still registered', async () => {
    const native = fakeController({ active: SAVED, lastKnownGood: SAVED, ok: true });
    mocks.controller.mockReturnValue(native);
    const { rerender, unmount } = renderHook((p) => useShortcutGestures(p), {
      initialProps: options(SAVED, true),
    });
    await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(1));
    rerender(options('F13', true));
    await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(2));
    expect(native.setShortcut).toHaveBeenLastCalledWith('F13');
    unmount();
  });
});

describe('useShortcutRegistration before boot is ready', () => {
  it('does not treat the hydrated shortcut as a change', async () => {
    const setShortcut = vi.fn(async () => refused);
    const nativeRef = { current: { setShortcut } } as unknown as MutableRefObject<NativeShortcutController | null>;
    const registeredRef = { current: null } as MutableRefObject<string | null>;
    const revert = vi.fn();
    const callbacksRef = { current: { onShortcutError: vi.fn(), onShortcutRevert: revert } };
    const hook = renderHook(
      ({ shortcut, ready }) => useShortcutRegistration(shortcut, nativeRef, registeredRef, callbacksRef, async () => false, ready),
      { initialProps: { ready: false, shortcut: 'Ctrl + Shift + Space' } },
    );
    hook.rerender({ ready: true, shortcut: SAVED });
    await new Promise((r) => setTimeout(r, 10));
    expect(setShortcut).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });
});
