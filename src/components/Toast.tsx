import { Icon } from './Icon';

export type ToastTone = 'ok' | 'warn' | 'err';

interface ToastProps {
  message: string;
  tone?: ToastTone;
}

const icons = { err: 'warn', ok: 'check', warn: 'info' } as const;

/**
 * Infer severity from the app's real strings (SPEC: toast gets an icon by
 * severity). Errors: failures, in-use shortcuts, expired buffers, retry guard.
 * Warnings: copied fallback, unverified or uncertain inserts.
 */
export function toastTone(message: string): ToastTone {
  if (/fail|couldn|can’t|can't|error|expired|in use|finish the current|unable|denied|nothing transcribed/i.test(message)) {
    return 'err';
  }
  if (/not verified|unverified|may have|also copied|^copied —|inspect/i.test(message)) return 'warn';
  return 'ok';
}

/** Bottom-center toast, announced politely; timings live in useToastMessages. */
export function Toast({ message, tone = toastTone(message) }: ToastProps) {
  return (
    <div aria-live="polite" className={`toast t-${tone}${message ? ' visible' : ''}`}>
      {message && <Icon name={icons[tone]} size={14} />}
      {message}
    </div>
  );
}
