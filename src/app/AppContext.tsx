import {
  createContext,
  type Dispatch,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { initialSettings } from '../domain/fixtures';
import { createClipboardAdapter, type ClipboardAdapter } from
  '../services/clipboard';
import type {
  DictationLifecycle,
  DictionaryCrud,
  HistoryDeletion,
  SettingsStore,
  SetupLifecycle,
} from '../services/contracts';
import {
  createDefaultDictionaryStore,
  type DurableDictionaryStore,
} from '../services/dictionary';
import {
  createDefaultHistoryStore,
  type HistoryStore,
} from '../services/history';
import {
  SETTINGS_FILE_VERSION,
  createDefaultSettingsStore,
  type DurableSettingsStore,
  type SettingsFile,
} from '../services/settings';
import {
  createDictionaryService,
  createHistoryService,
  createSettingsService,
  createSetupService,
} from '../services/mock/appServices';
import { createMockDictationService } from
  '../services/mock/dictationService';
import { appReducer, createInitialState, type AppAction, type AppState } from
  './state';

interface AppContextValue {
  /**
   * True after settings/history/dictionary initial load attempts settle
   * (success or fail-safe). False only while durable boot hydrate is in
   * flight — gates Settings/History/Dictionary so fixture defaults never
   * flash.
   */
  bootReady: boolean;
  clipboard: ClipboardAdapter;
  dictation: DictationLifecycle;
  dictionary: DictionaryCrud;
  /** True when Tauri (or test) durable dictionary.json persistence is on. */
  dictionaryDurable: boolean;
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
   * Injectable dictionary persistence (tests). When omitted, Tauri enables
   * durable app-data IO; browser / jsdom stay memory-only and disabled.
   */
  dictionaryPersistence?: {
    enabled: boolean;
    store: DurableDictionaryStore;
  };
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
  dictionaryPersistence,
  historyPersistence,
  settingsPersistence,
}: AppProviderProps) {
  const dictionaryPers = useMemo(
    () => dictionaryPersistence ?? createDefaultDictionaryStore(),
    [dictionaryPersistence],
  );
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
      persistDictionary: dictionaryPers.enabled,
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

  const dictionaryHydratedRef = useRef(!dictionaryPers.enabled);
  const allowDictionaryPersistRef = useRef(!dictionaryPers.enabled);
  const dictionaryPersistGenRef = useRef(0);
  /** Last successfully saved words — roll back UI on save failure. */
  const lastSavedWordsRef = useRef<string[] | null>(null);

  const needsBootHydrate = settingsPers.enabled
    || historyPers.enabled
    || dictionaryPers.enabled;
  const [bootReady, setBootReady] = useState(!needsBootHydrate);

  // Boot: load durable settings first, then dictionary + history (retention
  // hydrated settings). Corrupt settings → defaults + toast; never touch
  // history.json from the settings path. Mark bootReady after every path
  // settles so gated screens never flash fixture defaults / empty lists.
  useEffect(() => {
    let cancelled = false;

    // BUS-42: a migrated (older-version) or backed-up corrupt settings.json
    // is rewritten as the current version during boot, so every later reader
    // (including other windows) sees a current file.
    const rewriteSettings = async (file: SettingsFile) => {
      try {
        await settingsPers.store.save(file.settings, file.onboardingComplete);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({
          message: `Failed to save settings: ${message}`,
          type: 'set-settings-error',
        });
      }
    };

    void (async () => {
      let retention = initialSettings.transcriptRetention;
      // Settings unreadable and not backed up: retention is unknown, so an
      // older history.json must not be migrated (rewritten) yet. BUS-42.
      let settingsBlocked = false;
      // Settings were unreadable, backed up and reset: retention fell back to
      // the default, so history.json must be backed up before any prune.
      let settingsReset = false;

      if (settingsPers.enabled) {
        const result = await settingsPers.store.load();
        if (cancelled) return;
        if (result.ok) {
          dispatch({
            onboardingComplete: result.file.onboardingComplete,
            settings: result.file.settings,
            type: 'hydrate-settings',
          });
          lastSavedSettingsRef.current = result.file;
          allowSettingsPersistRef.current = true;
          retention = result.file.settings.transcriptRetention;
          if (result.needsRewrite) {
            await rewriteSettings(result.file);
            if (cancelled) return;
          }
        } else {
          // Safe defaults already in state; surface error. Writing defaults
          // is allowed only once the unreadable file was backed up.
          allowSettingsPersistRef.current = !result.writeBlocked;
          settingsBlocked = result.writeBlocked;
          settingsReset = !result.writeBlocked;
          lastSavedSettingsRef.current = result.file;
          dispatch({
            message: result.error,
            type: 'set-settings-error',
          });
          if (!result.writeBlocked) {
            // Corrupt file already backed up: replace it with defaults now.
            await rewriteSettings(result.file);
            if (cancelled) return;
          }
        }
        settingsHydratedRef.current = true;
        settingsPersistGenRef.current += 1;
      } else {
        settingsHydratedRef.current = true;
        allowSettingsPersistRef.current = false;
      }

      if (dictionaryPers.enabled) {
        const dictResult = await dictionaryPers.store.load();
        if (cancelled) return;
        if (dictResult.ok) {
          dispatch({ type: 'hydrate-words', words: dictResult.file.words });
          lastSavedWordsRef.current = dictResult.file.words;
          allowDictionaryPersistRef.current = true;
        } else {
          // Safe empty already in state; surface error; still allow first
          // successful write so the user can recover without touching
          // settings.json / history.json.
          allowDictionaryPersistRef.current = !dictResult.writeBlocked;
          lastSavedWordsRef.current = dictResult.file.words;
          dispatch({
            message: dictResult.error,
            type: 'set-dictionary-error',
          });
          if (!dictResult.writeBlocked) {
            // Unreadable file already backed up: replace it with a valid
            // empty file now so the error does not recur every launch.
            try {
              await dictionaryPers.store.save(dictResult.file.words);
            } catch {
              // Original is backed up; the next edit retries the write.
            }
            if (cancelled) return;
          }
        }
        dictionaryHydratedRef.current = true;
        dictionaryPersistGenRef.current += 1;
      } else {
        dictionaryHydratedRef.current = true;
        allowDictionaryPersistRef.current = false;
      }

      if (!historyPers.enabled) {
        historyHydratedRef.current = true;
        allowHistoryPersistRef.current = false;
        if (!cancelled) setBootReady(true);
        return;
      }

      const historyResult = await historyPers.store.load(retention, clock());
      if (cancelled) return;
      let historyBackupFailed = false;
      if (historyResult.ok && settingsReset && !settingsBlocked) {
        const outcome = historyPers.store.backup
          ? await historyPers.store.backup()
          : 'failed';
        if (cancelled) return;
        historyBackupFailed = outcome === 'failed';
      }
      if (historyResult.ok && (settingsBlocked || historyBackupFailed)) {
        // Any history version: show it, but never rewrite or prune it on
        // default retention while settings writes are blocked.
        dispatch({ records: historyResult.records, type: 'hydrate-records' });
        allowHistoryPersistRef.current = false;
        dispatch({
          message: settingsBlocked
            ? 'History is read-only until settings can be read. Your history file was left untouched.'
            : 'History is read-only because it couldn\'t be backed up after settings were reset. Your history file was left untouched.',
          sticky: true,
          type: 'set-history-error',
        });
      } else if (historyResult.ok) {
        dispatch({ records: historyResult.records, type: 'hydrate-records' });
        allowHistoryPersistRef.current = true;
      } else {
        // Unreadable / unknown-version history.json: never write over it
        // (the store already tried to back it up). BUS-42.
        allowHistoryPersistRef.current = false;
        dispatch({
          message: historyResult.error,
          sticky: true,
          type: 'set-history-error',
        });
      }
      historyHydratedRef.current = true;
      historyPersistGenRef.current += 1;
      if (!cancelled) setBootReady(true);
    })();

    return () => {
      cancelled = true;
    };
    // Intentional once-on-mount boot load (persistence identity is stable).
  }, [clock, dictionaryPers, historyPers, settingsPers]);

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
        dispatch({ message: null, type: 'set-settings-error' });
      } catch (error: unknown) {
        if (gen !== settingsPersistGenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        const rollback = lastSavedSettingsRef.current;
        if (rollback) {
          dispatch({
            onboardingComplete: rollback.onboardingComplete,
            settings: rollback.settings,
            type: 'hydrate-settings',
          });
        }
        dispatch({
          message: `Failed to save settings: ${message}`,
          type: 'set-settings-error',
        });
      }
    })();
  }, [
    settingsPers,
    state.onboarding.complete,
    state.settings,
  ]);

  // Persist dictionary after hydrate whenever words change. Optimistic UI
  // with rollback to last successful save on write failure.
  useEffect(() => {
    if (
      !dictionaryPers.enabled
      || !dictionaryHydratedRef.current
      || !allowDictionaryPersistRef.current
    ) {
      return;
    }
    const last = lastSavedWordsRef.current;
    if (last && JSON.stringify(last) === JSON.stringify(state.words)) {
      return;
    }
    const snapshot = [...state.words];
    const gen = dictionaryPersistGenRef.current;
    void (async () => {
      try {
        await dictionaryPers.store.save(snapshot);
        if (gen !== dictionaryPersistGenRef.current) return;
        lastSavedWordsRef.current = snapshot;
        dispatch({ message: null, type: 'set-dictionary-error' });
      } catch (error: unknown) {
        if (gen !== dictionaryPersistGenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        const rollback = lastSavedWordsRef.current;
        if (rollback) {
          dispatch({ type: 'hydrate-words', words: rollback });
        }
        dispatch({
          message: `Failed to save dictionary: ${message}`,
          type: 'set-dictionary-error',
        });
      }
    })();
  }, [dictionaryPers, state.words]);

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
        dispatch({ message: null, type: 'set-history-error' });
      } catch (error: unknown) {
        if (gen !== historyPersistGenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        dispatch({
          message: `Failed to save history: ${message}`,
          type: 'set-history-error',
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
    bootReady,
    clipboard,
    dictation,
    dictionary,
    dictionaryDurable: dictionaryPers.enabled,
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
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}
