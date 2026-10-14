import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { NativeShortcutController } from '../services/shortcut';
import { emitShortcutBound } from '../services/shortcut/bindingEvents';
import { isSettingsWindowOpen } from '../services/settingsWindow';
import { inUseText, noneActiveText } from '../features/settings/shortcutCopy';

interface RegistrationCallbacks {
  onShortcutError?: (message: string) => void;
  onShortcutRevert?: (shortcut: string) => void;
}

/**
 * BUS-47: re-register when Settings' shortcut *changes* (native only).
 *
 * The mount effect owns the initial bind and seeds `registeredRef` from the
 * boot outcome. Native setShortcut calls are serialized, so ok results arrive
 * in order; every ok is recorded *before* the cancelled check, which keeps
 * `registeredRef` equal to what the OS actually holds (native re-binds its
 * lastKnownGood on refusal; `active: null` means that failed too). That combo
 * is the revert target, and it is broadcast as `active` so the Settings
 * recorder uses the same truth. The Settings status line reports refusals;
 * main only toasts (in words, never the raw error) when Settings is closed.
 */
export function useShortcutRegistration(
  shortcut: string,
  nativeRef: MutableRefObject<NativeShortcutController | null>,
  registeredRef: MutableRefObject<string | null>,
  callbacksRef: MutableRefObject<RegistrationCallbacks>,
  settingsOpen: () => Promise<boolean> = isSettingsWindowOpen,
) {
  const boundShortcutRef = useRef<string | null>(null);
  useEffect(() => {
    const native = nativeRef.current;
    if (!native || !isTauri()) return;
    if (boundShortcutRef.current === null) {
      boundShortcutRef.current = shortcut;
      return;
    }
    if (boundShortcutRef.current === shortcut) return;
    boundShortcutRef.current = shortcut;
    let cancelled = false;
    void (async () => {
      const outcome = await native.setShortcut(shortcut);
      // Record what the OS holds even if a newer change superseded us.
      if (outcome.ok) registeredRef.current = shortcut;
      const previous = registeredRef.current;
      // Refused and restore failed: nothing is registered any more.
      if (!outcome.ok && outcome.active === null) registeredRef.current = null;
      const active = registeredRef.current;
      emitShortcutBound({
        active, message: outcome.ok ? undefined : outcome.message, ok: outcome.ok, previous, shortcut,
      });
      if (cancelled || outcome.ok) return;
      // Don't keep (or retry next launch) a combo the OS refused. With nothing
      // active, keep the previous combo so the next launch retries it.
      const target = active ?? previous;
      if (target !== null && target !== shortcut) {
        boundShortcutRef.current = target;
        callbacksRef.current.onShortcutRevert?.(target);
      }
      if (await settingsOpen()) return;
      callbacksRef.current.onShortcutError?.(active === null
        ? noneActiveText(shortcut, previous)
        : inUseText(shortcut, active));
    })();
    return () => {
      cancelled = true;
    };
  }, [shortcut, nativeRef, registeredRef, callbacksRef, settingsOpen]);
}
