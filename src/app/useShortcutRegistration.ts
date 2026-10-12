import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { NativeShortcutController } from '../services/shortcut';
import { emitShortcutBound } from '../services/shortcut/bindingEvents';

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
 * lastKnownGood on refusal). That combo is the revert target, and it is
 * broadcast as `active` so the Settings recorder uses the same truth.
 */
export function useShortcutRegistration(
  shortcut: string,
  nativeRef: MutableRefObject<NativeShortcutController | null>,
  registeredRef: MutableRefObject<string | null>,
  callbacksRef: MutableRefObject<RegistrationCallbacks>,
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
      const active = registeredRef.current;
      emitShortcutBound({
        active, message: outcome.ok ? undefined : outcome.message, ok: outcome.ok, shortcut,
      });
      if (cancelled || outcome.ok) return;
      // Don't keep (or retry next launch) a combo the OS refused. With no
      // accepted combo at all there is nothing better to revert to.
      if (active !== null && active !== shortcut) {
        boundShortcutRef.current = active;
        callbacksRef.current.onShortcutRevert?.(active);
      }
      if (outcome.message) callbacksRef.current.onShortcutError?.(outcome.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [shortcut, nativeRef, registeredRef, callbacksRef]);
}
