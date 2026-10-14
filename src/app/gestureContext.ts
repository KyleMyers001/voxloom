import type { OnboardingState } from '../domain/types';
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
  const changes: Partial<OnboardingState> = {};
  if (gesture === 'hold-start') {
    changes.recognizedText = 'Hold gesture started (no speech captured).';
  }
  if (gesture === 'hold-finish') changes.holdTested = true;
  if (gesture === 'latch-start') {
    changes.recognizedText =
      'Double-tap latched. Activate once more to finish (no speech captured).';
  }
  if (gesture === 'latch-finish') {
    changes.recognizedText = 'Double-tap gesture finished (no speech captured).';
    changes.tapTested = true;
  }
  options.setup.update(changes);
}
