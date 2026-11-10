// BUS-47: a refusal whose restore also fails clears the revert target, and
// main toasts (in words) only when the Settings window can't say it.
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as unknown[]);
const retry = vi.hoisted(() => ({ handler: null as null | ((s: string) => void) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../../src/services/shortcut/bindingEvents', () => ({
  emitShortcutBound: (p: unknown) => { emitted.push(p); },
  listenShortcutRetry: async (handler: (s: string) => void) => {
    retry.handler = handler;
    return () => { retry.handler = null; };
  },
}));

import { useShortcutRegistration } from '../../src/app/useShortcutRegistration';
import type { NativeShortcutController, RegisterOutcome } from '../../src/services/shortcut';

function setup(outcome: RegisterOutcome, settingsOpen: boolean, registered: string | null = 'Ctrl + Shift + Space') {
  emitted.length = 0;
  retry.handler = null;
  const native = { setShortcut: vi.fn(async () => outcome) } as unknown as NativeShortcutController;
  const nativeRef = { current: native } as MutableRefObject<NativeShortcutController | null>;
  const registeredRef = { current: registered } as MutableRefObject<string | null>;
  const errors: string[] = [];
  const reverts: string[] = [];
  const callbacksRef = { current: {
    onShortcutError: (m: string) => { errors.push(m); },
    onShortcutRevert: (s: string) => { reverts.push(s); },
  } };
  const open = async () => settingsOpen;
  const hook = renderHook(
    ({ shortcut }) => useShortcutRegistration(shortcut, nativeRef, registeredRef, callbacksRef, open),
    { initialProps: { shortcut: 'Ctrl + Shift + Space' } },
  );
  return { errors, hook, native, registeredRef, reverts };
}

const doubleFailure: RegisterOutcome = {
  active: null, attempted: 'Control+Alt+T', lastKnownGood: 'Control+Shift+Space',
  message: 'raw', ok: false,
};

describe('useShortcutRegistration', () => {
  it('refused and restore failed: clears registeredRef and says no shortcut is active', async () => {
    const { errors, hook, registeredRef, reverts } = setup(doubleFailure, false);
    await act(async () => hook.rerender({ shortcut: 'Ctrl + Alt + T' }));
    await waitFor(() => expect(errors).toHaveLength(1));
    expect(registeredRef.current).toBeNull();
    expect(emitted).toEqual([expect.objectContaining({
      active: null, ok: false, previous: 'Ctrl + Shift + Space', shortcut: 'Ctrl + Alt + T',
    })]);
    expect(errors[0]).toBe('Couldn\'t set ⌃⌥T or restore ⌃⇧Space. No shortcut is active. Record one.');
    expect(reverts).toEqual(['Ctrl + Shift + Space']); // never keep the refused combo
  });

  it('does not toast when the Settings window is open (its status line says it)', async () => {
    const { errors, hook, reverts } = setup({
      active: 'Control+Shift+Space', attempted: 'Control+Alt+B', lastKnownGood: 'Control+Shift+Space',
      message: 'Could not bind (HotKey already registered)', ok: false,
    }, true);
    await act(async () => hook.rerender({ shortcut: 'Ctrl + Alt + B' }));
    await waitFor(() => expect(reverts).toEqual(['Ctrl + Shift + Space']));
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual([]);
  });

  it('with Settings closed, toasts in words, never the raw error', async () => {
    const { errors, hook } = setup({
      active: 'Control+Shift+Space', attempted: 'Control+Alt+B', lastKnownGood: 'Control+Shift+Space',
      message: 'Could not bind (HotKey already registered)', ok: false,
    }, false);
    await act(async () => hook.rerender({ shortcut: 'Ctrl + Alt + B' }));
    await waitFor(() => expect(errors).toEqual(['⌃⌥B is in use by another app. Using ⌃⇧Space instead.']));
  });

  it('a change is a user save (may ask for Accessibility); the first value is not', async () => {
    const ok: RegisterOutcome = { active: 'F13', lastKnownGood: 'F13', ok: true };
    const { hook, native } = setup(ok, false);
    await act(async () => undefined);
    expect(native.setShortcut).not.toHaveBeenCalled();
    await act(async () => hook.rerender({ shortcut: 'F13' }));
    expect(native.setShortcut).toHaveBeenCalledWith('F13', { userInitiated: true });
  });

  describe('Settings re-saves a saved shortcut that nothing holds (refused launch)', () => {
    const refused: RegisterOutcome = {
      active: null, attempted: 'F13', lastKnownGood: null, message: 'Accessibility permission is needed', ok: false,
    };

    it('tries again as a user save, and says so to every window', async () => {
      const { native } = setup(refused, true, null);
      await waitFor(() => expect(retry.handler).not.toBeNull());
      await act(async () => retry.handler!('Ctrl + Shift + Space'));
      expect(native.setShortcut).toHaveBeenCalledWith('Ctrl + Shift + Space', { userInitiated: true });
      expect(emitted).toEqual([expect.objectContaining({ active: null, ok: false, shortcut: 'Ctrl + Shift + Space' })]);
    });

    it('ignores a retry for a shortcut that is already active, or is not the saved one', async () => {
      const { native } = setup(refused, true, 'Ctrl + Shift + Space');
      await waitFor(() => expect(retry.handler).not.toBeNull());
      await act(async () => retry.handler!('Ctrl + Shift + Space'));
      await act(async () => retry.handler!('F13'));
      expect(native.setShortcut).not.toHaveBeenCalled();
    });

    it('a granted retry makes it active again', async () => {
      const { native, registeredRef } = setup(
        { active: 'Ctrl + Shift + Space', lastKnownGood: 'Ctrl + Shift + Space', ok: true }, true, null,
      );
      await waitFor(() => expect(retry.handler).not.toBeNull());
      await act(async () => retry.handler!('Ctrl + Shift + Space'));
      expect(native.setShortcut).toHaveBeenCalledTimes(1);
      expect(registeredRef.current).toBe('Ctrl + Shift + Space');
    });
  });
});
