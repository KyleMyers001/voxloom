import { dispatchPracticeGesture } from '../features/onboarding/practiceBridge';
import type { ShortcutContext, ShortcutGesture, SetupLifecycle } from '../services/contracts';
import type { AppState } from './state';
import { hasOpenModal } from './modalState';

/** The slice of gesture options these helpers read. */
interface ContextOptions {
  onboardingOpen: boolean;
  setup: SetupLifecycle;
  shortcutOpen: boolean;
  state: AppState;
}

export function interactionContext(options: ContextOptions): ShortcutContext {
  if (options.onboardingOpen) {
    return options.state.onboarding.step === 3 ? 'practice' : null;
  }
  return options.shortcutOpen || hasOpenModal() ? null : 'product';
}

export function handlePractice(options: ContextOptions, gesture: ShortcutGesture) {
  if (options.onboardingOpen && options.state.onboarding.step === 3) dispatchPracticeGesture(gesture);
}
