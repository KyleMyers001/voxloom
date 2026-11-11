import { dispatchPracticeGesture } from '../features/onboarding/practiceBridge';
import type { ShortcutContext, ShortcutGesture, SetupLifecycle } from '../services/contracts';
import type { DogfoodPhase } from '../services/stt/dogfoodPhase';
import type { AppState } from './state';
import { hasOpenModal } from './modalState';

/** The slice of gesture options these helpers read. */
interface ContextOptions {
  dogfood: { phase: DogfoodPhase };
  onboardingOpen: boolean;
  setup: SetupLifecycle;
  shortcutOpen: boolean;
  state: AppState;
}

/**
 * Setup opened over a product capture (Home or shortcut) that is still
 * recording: the shortcut keeps finishing it, and practice waits until it ends.
 */
export function setupOverProductCapture(options: ContextOptions): boolean {
  return options.onboardingOpen
    && (options.dogfood.phase === 'starting' || options.dogfood.phase === 'recording');
}

export function interactionContext(options: ContextOptions): ShortcutContext {
  // Still 'product', so the machine keeps the hold/latch it had before setup opened.
  if (setupOverProductCapture(options)) return 'product';
  if (options.onboardingOpen) {
    return options.state.onboarding.step === 3 ? 'practice' : null;
  }
  return options.shortcutOpen || hasOpenModal() ? null : 'product';
}

export function handlePractice(options: ContextOptions, gesture: ShortcutGesture) {
  if (options.onboardingOpen && options.state.onboarding.step === 3) dispatchPracticeGesture(gesture);
}
