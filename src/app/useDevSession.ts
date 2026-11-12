import { useState } from 'react';
import { useApp } from './AppContext';

/** Dev scenario panel actions: reset session (with durable-history prompt), then first-run setup. */
export function useDevSession(openOnboarding: () => void, clearOpener: () => void) {
  const { dispatch, dictionaryDurable, historyDurable, now, settingsDurable } = useApp();
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

  return {
    resetPromptOpen,
    closeResetPrompt: () => setResetPromptOpen(false),
    performReset,
    requestReset,
  };
}
