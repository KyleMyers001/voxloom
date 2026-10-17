import { useCallback, useRef, useState } from 'react';
import type { PrivacyPane } from './privacyPane';

/** Native arm error codes (src-tauri/src/cancel_scope ArmError.code). */
export type CancelUnavailableCode =
  | 'cancel-arm-failed'
  | 'cancel-ax-untrusted'
  | 'cancel-tap-create-failed';

/** Why Escape-cancel is off for this run; dictation itself keeps working. */
export interface CancelUnavailable {
  code: CancelUnavailableCode;
  /** Full native diagnostic, copied only when the user asks. */
  details: string;
}

const KNOWN_CODES: readonly string[] = [
  'cancel-arm-failed', 'cancel-ax-untrusted', 'cancel-tap-create-failed',
];

/** Read the structured `{ code, message }` arm rejection; never parse text. */
export function cancelUnavailableFrom(error: unknown): CancelUnavailable {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code, message } = error as { code: unknown; message?: unknown };
    if (typeof code === 'string' && KNOWN_CODES.includes(code)) {
      return {
        code: code as CancelUnavailableCode,
        details: typeof message === 'string' ? message : code,
      };
    }
  }
  const details = error instanceof Error ? error.message : String(error);
  return { code: 'cancel-arm-failed', details };
}

export function cancelUnavailableHint(code: CancelUnavailableCode): string {
  if (code === 'cancel-ax-untrusted') {
    // macOS may only apply a new grant to a relaunched process.
    return 'Escape-cancel is off: Voxloom does not have Accessibility permission. '
      + 'You may need to quit and reopen Voxloom. Dictation still works.';
  }
  return 'Escape-cancel is off: macOS could not start the Escape listener. Dictation still works.';
}

/**
 * The Settings pane that fixes this code, or null when no grant is known to
 * be missing (the tap failed despite Accessibility trust, or arming broke).
 */
export function cancelSettingsPane(code: CancelUnavailableCode): PrivacyPane | null {
  return code === 'cancel-ax-untrusted' ? 'accessibility' : null;
}

/**
 * Track the latest arm failure (`clear` on a successful arm). The toast hint
 * is handed out once per app run (`takeHint`), so it never nags or blocks.
 */
export function useCancelUnavailable() {
  const [notice, setNotice] = useState<CancelUnavailable | null>(null);
  const hintedRef = useRef(false);
  const pendingHintRef = useRef<string | null>(null);

  const report = useCallback((error: unknown) => {
    console.warn('Escape cancellation unavailable; dictating without it.', error);
    const unavailable = cancelUnavailableFrom(error);
    setNotice(unavailable);
    if (hintedRef.current) return;
    hintedRef.current = true;
    pendingHintRef.current = cancelUnavailableHint(unavailable.code);
  }, []);

  const takeHint = useCallback(() => {
    const hint = pendingHintRef.current;
    pendingHintRef.current = null;
    return hint;
  }, []);

  // A successful arm drops a hint that was queued but never shown; a later
  // failure in this run may hint again because the user never saw it.
  const clear = useCallback(() => {
    setNotice(null);
    if (pendingHintRef.current === null) return;
    pendingHintRef.current = null;
    hintedRef.current = false;
  }, []);

  return { clear, notice, report, takeHint };
}
