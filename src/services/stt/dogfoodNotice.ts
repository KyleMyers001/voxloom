/// The "replaced" notice of a superseded run, timed around the live
/// session's own toasts so neither hides the other.

import { toastMs } from '../../domain/toastTiming';
import type { DogfoodViewActions } from './dogfoodPhase';
import type { DogfoodLiveSession } from './dogfoodSessionState';

type Toasts = Pick<DogfoodViewActions, 'announceError' | 'errorToast' | 'toast'>;
/** The info toast's minimum visible time (useToastMessages). */
const INFO_MS = 1_800;

/** `text` with any held notice appended (and no longer held). */
export function withNotice(live: DogfoodLiveSession, text: string | null): string {
  const shown = [text, live.pendingNotice].filter(Boolean).join(' ');
  live.pendingNotice = null;
  return shown;
}

/**
 * Show a superseded run's notice. Never after the user cancelled; joined to
 * a start failure (error tone) or to the Escape-cancel hint still on screen;
 * held while the live session starts.
 */
export function showNotice(live: DogfoodLiveSession, text: string, toasts: Toasts) {
  const { ended, hintShown } = live;
  if (ended === 'cancelled') return;
  if (ended?.error) return toasts.errorToast(`${ended.error} ${text}`);
  if (live.active && !live.listening && !ended) {
    live.pendingNotice = text;
    return;
  }
  live.hintShown = null;
  const hint = live.listening && hintShown && Date.now() < hintShown.until ? hintShown.text : null;
  toasts.toast(hint ? `${hint} ${text}` : text);
}

/** After "Listening…": show a held notice and/or the Escape-cancel hint. */
export function afterListening(live: DogfoodLiveSession, hint: string | null, toast: (text: string) => void) {
  live.listening = true;
  const shown = withNotice(live, hint);
  live.hintShown = hint && shown === hint ? { text: hint, until: Date.now() + toastMs(hint, INFO_MS) } : null;
  if (shown) toast(shown);
}

/**
 * The live session ended before "Listening…": a user cancel drops a held
 * notice; a release shows it; a start failure carries it in its error toast.
 */
export function endWithoutListening(
  live: DogfoodLiveSession, how: 'cancelled' | 'released' | { error: string }, toasts: Toasts,
) {
  live.ended = typeof how === 'string' ? (how === 'cancelled' ? how : { error: null }) : how;
  if (how === 'cancelled') live.pendingNotice = null;
  else if (how === 'released') {
    const held = withNotice(live, null);
    if (held) toasts.toast(held);
  } else toasts.announceError(withNotice(live, how.error));
}
