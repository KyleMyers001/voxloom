import { useCallback, useRef, useState } from 'react';

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
  return code === 'cancel-ax-untrusted'
    ? 'Escape-cancel is off: Voxloom does not have Accessibility permission. Dictation still works.'
    : 'Escape-cancel is off: macOS could not start the Escape listener. Dictation still works.';
}

/**
 * Remember the first arm failure of this app run. The hint is handed out
 * once (`takeHint`); later failures only log, so it never nags or blocks.
 */
export function useCancelUnavailable() {
  const [notice, setNotice] = useState<CancelUnavailable | null>(null);
  const hintedRef = useRef(false);
  const pendingHintRef = useRef<string | null>(null);

  const report = useCallback((error: unknown) => {
    console.warn('Escape cancellation unavailable; dictating without it.', error);
    const unavailable = cancelUnavailableFrom(error);
    setNotice((previous) => previous ?? unavailable);
    if (hintedRef.current) return;
    hintedRef.current = true;
    pendingHintRef.current = cancelUnavailableHint(unavailable.code);
  }, []);

  const takeHint = useCallback(() => {
    const hint = pendingHintRef.current;
    pendingHintRef.current = null;
    return hint;
  }, []);

  return { notice, report, takeHint };
}
