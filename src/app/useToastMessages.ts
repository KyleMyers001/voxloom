import { useEffect, useState } from 'react';

const INFO_MS = 1_800;
const ERROR_MS = 4_000;

/** App toast: info for 1.8 s; store errors (history/settings/dictionary) for 4 s. */
export function useToastMessages(errors: (string | null | undefined)[]) {
  const [toast, setToast] = useState('');
  const [errorTone, setErrorTone] = useState(false);
  const show = (message: string, ms: number) => {
    setErrorTone(ms === ERROR_MS);
    setToast(message);
    window.setTimeout(() => setToast(''), ms);
  };
  const [historyError, settingsError, dictionaryError] = errors;
  useErrorToast(historyError, setToast);
  useErrorToast(settingsError, setToast);
  useErrorToast(dictionaryError, setToast);
  return {
    toast,
    /** announceError and store errors force the error tone; others are inferred from text. */
    toastTone: errorTone || errors.some((e) => e && e === toast) ? 'err' as const : undefined,
    announce: (message: string) => show(message, INFO_MS),
    announceError: (message: string) => show(message, ERROR_MS),
  };
}

function useErrorToast(error: string | null | undefined, setToast: (m: string) => void) {
  useEffect(() => {
    if (!error) return;
    setToast(error);
    const timer = window.setTimeout(() => setToast(''), ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [error, setToast]);
}
