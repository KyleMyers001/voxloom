// BUS-47: a refusal whose restore also fails clears the revert target, and
// main toasts (in words) only when the Settings window can't say it.
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as unknown[]);
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('../../src/services/shortcut/bindingEvents', () => ({
  emitShortcutBound: (p: unknown) => { emitted.push(p); },
}));

import { useShortcutRegistration } from '../../src/app/useShortcutRegistration';
import type { NativeShortcutController, RegisterOutcome } from '../../src/services/shortcut';

function setup(outcome: RegisterOutcome, settingsOpen: boolean) {
  emitted.length = 0;
  const native = { setShortcut: vi.fn(async () => outcome) } as unknown as NativeShortcutController;
  const nativeRef = { current: native } as MutableRefObject<NativeShortcutController | null>;
  const registeredRef = { current: 'Ctrl + Shift + Space' } as MutableRefObject<string | null>;
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
    await waitFor(() => expect(errors).toEqual(['⌃⌥B is in use by another app. Kept ⌃⇧Space.']));
  });
});
