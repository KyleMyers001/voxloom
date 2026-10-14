import { useCallback, useEffect, useRef, useState } from 'react';

const INFO_MS = 1_800;
const ERROR_MS = 4_000;

/**
 * App toast: info for 1.8 s; errors (announceError, history/settings/dictionary
 * store errors) for 4 s. One timer at a time: a newer toast clears the older
 * timer, so an old timeout can never hide it early.
 */
export function useToastMessages(errors: (string | null | undefined)[]) {
  const [toast, setToast] = useState('');
  const [errorTone, setErrorTone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((message: string, ms: number) => {
    window.clearTimeout(timer.current);
    setErrorTone(ms === ERROR_MS);
    setToast(message);
    timer.current = window.setTimeout(() => setToast(''), ms);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const [historyError, settingsError, dictionaryError] = errors;
  useEffect(() => { if (historyError) show(historyError, ERROR_MS); }, [historyError, show]);
  useEffect(() => { if (settingsError) show(settingsError, ERROR_MS); }, [settingsError, show]);
  useEffect(() => { if (dictionaryError) show(dictionaryError, ERROR_MS); }, [dictionaryError, show]);
  const announce = useCallback((message: string) => show(message, INFO_MS), [show]);
  const announceError = useCallback((message: string) => show(message, ERROR_MS), [show]);
  return {
    toast,
    /** announceError and store errors force the error tone; others are inferred from text. */
    toastTone: errorTone ? 'err' as const : undefined,
    announce,
    announceError,
  };
}
