import { useState } from 'react';
import type { OnboardingScenario } from '../dev/ScenarioPanel';
import { initialOnboarding } from '../domain/fixtures';
import { useApp } from './AppContext';

/** Dev scenario panel actions: reset session (with durable-history prompt) and onboarding scenarios. */
export function useDevSession(openOnboarding: () => void, clearOpener: () => void) {
  const { dispatch, dictionaryDurable, historyDurable, now, settings, settingsDurable, setup } = useApp();
  const [resetPromptOpen, setResetPromptOpen] = useState(false);

  function performReset(wipeHistory: boolean) {
    clearOpener();
    setResetPromptOpen(false);
    dispatch({
      now: now(),
      persistDictionary: dictionaryDurable,
      persistHistory: historyDurable,
      persistSettings: settingsDurable,
      type: 'reset',
      wipeHistory,
    });
    openOnboarding();
  }

  function requestReset() {
    if (historyDurable) {
      setResetPromptOpen(true);
      return;
    }
    performReset(false);
  }

  function openScenario(scenario: OnboardingScenario) {
    const collision = scenario === 'collision';
    setup.replace({
      ...initialOnboarding,
      microphoneGranted: collision,
      permissionDenied: scenario === 'permission-denied',
      shortcutCollision: collision,
      step: collision ? 2 : 1,
    });
    if (collision) settings.update({ key: 'shortcut', value: 'Ctrl + Space' });
    openOnboarding();
  }

  return {
    resetPromptOpen,
    closeResetPrompt: () => setResetPromptOpen(false),
    performReset,
    requestReset,
    openScenario,
  };
}
