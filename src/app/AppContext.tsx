import {
  createContext,
  type Dispatch,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { initialSettings } from "../domain/fixtures";
import { createClipboardAdapter, type ClipboardAdapter } from
  "../services/clipboard";
import type {
  DictationLifecycle,
  DictionaryCrud,
  HistoryDeletion,
  SettingsStore,
  SetupLifecycle,
} from "../services/contracts";
import {
  createDefaultHistoryStore,
  type HistoryStore,
} from "../services/history";
import {
  SETTINGS_FILE_VERSION,
  createDefaultSettingsStore,
  type DurableSettingsStore,
  type SettingsFile,
} from "../services/settings";
import {
  createDictionaryService,
  createHistoryService,
  createSettingsService,
  createSetupService,
} from "../services/mock/appServices";
import { createMockDictationService } from
  "../services/mock/dictationService";
import { appReducer, createInitialState, type AppAction, type AppState } from
  "./state";

interface AppContextValue {
  clipboard: ClipboardAdapter;
  dictation: DictationLifecycle;
  dictionary: DictionaryCrud;
  dispatch: Dispatch<AppAction>;
  history: HistoryDeletion;
  /** True when Tauri (or test) durable history.json persistence is on. */
  historyDurable: boolean;
  now: () => number;
  settings: SettingsStore;
  /** True when Tauri (or test) durable settings.json persistence is on. */
  settingsDurable: boolean;
  setup: SetupLifecycle;
  state: AppState;
}

const AppContext = createContext<AppContextValue | null>(null);

interface AppProviderProps {
  children: ReactNode;
  clock?: () => number;
  /**
   * Injectable history persistence (tests). When omitted, Tauri enables
   * durable app-data IO; browser / jsdom stay memory-only and disabled.
   */
  historyPersistence?: { enabled: boolean; store: HistoryStore };
  /**
   * Injectable settings persistence (tests). When omitted, Tauri enables
   * durable app-data IO; browser / jsdom stay memory-only and disabled.
   */
  settingsPersistence?: { enabled: boolean; store: DurableSettingsStore };
}

export function AppProvider({
  children,
  clock = Date.now,
  historyPersistence,
  settingsPersistence,
}: AppProviderProps) {
  const historyPers = useMemo(
    () => historyPersistence ?? createDefaultHistoryStore(),
    [historyPersistence],
  );
  const settingsPers = useMemo(
    () => settingsPersistence ?? createDefaultSettingsStore(),
    [settingsPersistence],
  );
  const [state, dispatch] = useReducer(
    appReducer,
    clock(),
    (now) => createInitialState(now, {
      persistHistory: historyPers.enabled,
      persistSettings: settingsPers.enabled,
    }),
  );
  const clipboard = useMemo(
    () => createClipboardAdapter(() => state.clipboardFailure),
    [state.clipboardFailure],
  );
  const dictation = useMemo(
    () => createMockDictationService({ dispatch, now: clock }),
    [clock],
  );
  const dictionary = useMemo(() => createDictionaryService(dispatch), []);
  const history = useMemo(() => createHistoryService(dispatch), []);
  const settings = useMemo(() => createSettingsService(dispatch), []);
  const setup = useMemo(() => createSetupService(dispatch), []);

  const settingsHydratedRef = useRef(!settingsPers.enabled);
  const allowSettingsPersistRef = useRef(!settingsPers.enabled);
  const settingsPersistGenRef = useRef(0);
  /** Last successfully saved snapshot — used to roll back UI on save failure. */
  const lastSavedSettingsRef = useRef<SettingsFile | null>(null);

  const historyHydratedRef = useRef(!historyPers.enabled);
  /** False after a corrupt-load so we never overwrite the broken file. */
  const allowHistoryPersistRef = useRef(!historyPers.enabled);
  const historyPersistGenRef = useRef(0);

  // Boot: load durable settings first, then history (retention depends on
  // hydrated settings). Corrupt settings → defaults + toast; never touch
  // history.json from the settings path.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let retention = initialSettings.transcriptRetention;

      if (settingsPers.enabled) {
        const result = await settingsPers.store.load();
        if (cancelled) return;
        if (result.ok) {
          dispatch({
            onboardingComplete: result.file.onboardingComplete,
            settings: result.file.settings,
            type: "hydrate-settings",
          });
          lastSavedSettingsRef.current = result.file;
          allowSettingsPersistRef.current = true;
          retention = result.file.settings.transcriptRetention;
        } else {
          // Safe defaults already in state; surface error; still allow
          // first successful write of defaults so the user can recover.
          allowSettingsPersistRef.current = true;
          lastSavedSettingsRef.current = result.file;
          dispatch({
            message: result.error,
            type: "set-settings-error",
          });
        }
        settingsHydratedRef.current = true;
        settingsPersistGenRef.current += 1;
      } else {
        settingsHydratedRef.current = true;
        allowSettingsPersistRef.current = false;
      }

      if (!historyPers.enabled) {
        historyHydratedRef.current = true;
        allowHistoryPersistRef.current = false;
        return;
      }

      const historyResult = await historyPers.store.load(retention, clock());
      if (cancelled) return;
      if (historyResult.ok) {
        dispatch({ records: historyResult.records, type: "hydrate-records" });
        allowHistoryPersistRef.current = true;
      } else {
        allowHistoryPersistRef.current = false;
        dispatch({
          message: historyResult.error,
          type: "set-history-error",
        });
      }
      historyHydratedRef.current = true;
      historyPersistGenRef.current += 1;
    })();

    return () => {
      cancelled = true;
    };
    // Intentional once-on-mount boot load (persistence identity is stable).
  }, [clock, historyPers, settingsPers]);

  // Persist settings after hydrate whenever settings or onboarding-complete
  // change. Strategy: optimistic UI (reducer updates immediately) with
  // rollback to last successful save on write failure.
  useEffect(() => {
    if (
      !settingsPers.enabled
      || !settingsHydratedRef.current
      || !allowSettingsPersistRef.current
    ) {
      return;
    }
    const snapshot: SettingsFile = {
      onboardingComplete: state.onboarding.complete,
      settings: state.settings,
      version: SETTINGS_FILE_VERSION,
    };
    const last = lastSavedSettingsRef.current;
    if (
      last
      && last.onboardingComplete === snapshot.onboardingComplete
      && JSON.stringify(last.settings) === JSON.stringify(snapshot.settings)
    ) {
      return;
    }
    const gen = settingsPersistGenRef.current;
    void (async () => {
      try {
        await settingsPers.store.save(
          snapshot.settings,
          snapshot.onboardingComplete,
        );
        if (gen !== settingsPersistGenRef.current) return;
        lastSavedSettingsRef.current = snapshot;
        dispatch({ message: null, type: "set-settings-error" });
      } catch (error: unknown) {
        if (gen !== settingsPersistGenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        const rollback = lastSavedSettingsRef.current;
        if (rollback) {
          dispatch({
            onboardingComplete: rollback.onboardingComplete,
            settings: rollback.settings,
            type: "hydrate-settings",
          });
        }
        dispatch({
          message: `Failed to save settings: ${message}`,
          type: "set-settings-error",
        });
      }
    })();
  }, [
    settingsPers,
    state.onboarding.complete,
    state.settings,
  ]);

  // Persist history after a successful hydrate whenever records or retention
  // change.
  useEffect(() => {
    if (
      !historyPers.enabled
      || !historyHydratedRef.current
      || !allowHistoryPersistRef.current
    ) {
      return;
    }
    const gen = historyPersistGenRef.current;
    void (async () => {
      try {
        await historyPers.store.save(
          state.records,
          state.settings.transcriptRetention,
          clock(),
        );
        if (gen !== historyPersistGenRef.current) return;
        dispatch({ message: null, type: "set-history-error" });
      } catch (error: unknown) {
        if (gen !== historyPersistGenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        dispatch({
          message: `Failed to save history: ${message}`,
          type: "set-history-error",
        });
      }
    })();
  }, [
    clock,
    historyPers,
    state.records,
    state.settings.transcriptRetention,
  ]);

  const value = {
    clipboard,
    dictation,
    dictionary,
    dispatch,
    history,
    historyDurable: historyPers.enabled,
    now: clock,
    settings,
    settingsDurable: settingsPers.enabled,
    setup,
    state,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
