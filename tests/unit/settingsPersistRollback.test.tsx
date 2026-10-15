import { renderHook, waitFor } from '@testing-library/react';
import { useReducer, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { appReducer, createInitialState } from '../../src/app/state';
import { useSettingsPersist } from '../../src/app/useSettingsPersist';
import { SETTINGS_FILE_VERSION, type DurableSettingsStore } from '../../src/services/settings';

describe('useSettingsPersist: failed Off save restores transcripts (BUS-78 P1)', () => {
  it('rolls Retention Off back and restores the cleared in-memory records', async () => {
    const base = createInitialState(1_000);
    const start = { ...base, settings: { ...base.settings, transcriptRetention: 'forever' as const } };
    const ids = start.records.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const store = { save } as unknown as DurableSettingsStore;
    const persistence = { enabled: true, store };
    const { result } = renderHook(() => {
      const [state, dispatch] = useReducer(appReducer, start);
      const saved = { onboardingComplete: state.onboarding.complete, settings: start.settings, version: SETTINGS_FILE_VERSION };
      const lastSavedRef = useRef(saved);
      const lastRequestedRef = useRef(saved);
      useSettingsPersist({
        allowRef: useRef(true), dispatch, hydratedRef: useRef(true), lastRequestedRef, lastSavedRef,
        onboardingComplete: state.onboarding.complete, persistence, persistGenRef: useRef(0), settings: state.settings,
      });
      return { dispatch, state };
    });
    result.current.dispatch({ key: 'transcriptRetention', now: Date.now(), type: 'set-setting', value: 'off' });
    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(result.current.state.settings.transcriptRetention).toBe('forever'));
    expect(result.current.state.records.map((r) => r.id)).toEqual(ids);
    expect(result.current.state.settingsError).toMatch(/disk full/);
  });
});
