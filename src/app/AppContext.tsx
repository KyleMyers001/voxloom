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
  createDefaultSettingsStore,
  type DurableSettingsStore,
  type SettingsFile,
} from '../services/settings';
import { useSettingsPersist } from './useSettingsPersist';
import { useSettingsSync } from './useSettingsSync';
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
  const historyDispatch = useMemo(() => createHistoryService(dispatch), []);
  const settings = useMemo(() => createSettingsService(dispatch), []);
  const setup = useMemo(() => createSetupService(dispatch), []);

  const settingsHydratedRef = useRef(!settingsPers.enabled);
  const allowSettingsPersistRef = useRef(!settingsPers.enabled);
  const settingsPersistGenRef = useRef(0);
  /** Last successfully saved snapshot — used to roll back UI on save failure. */
  const lastSavedSettingsRef = useRef<SettingsFile | null>(null);
  /** Last value handed to save() (not yet necessarily on disk). */
  const lastRequestedSettingsRef = useRef<SettingsFile | null>(null);

  const historyHydratedRef = useRef(!historyPers.enabled);
  /** False after a corrupt-load so we never overwrite the broken file. */
  const allowHistoryPersistRef = useRef(!historyPers.enabled);
  const historyPersistGenRef = useRef(0);
  /** One queue for history.json writes/reloads so an Off wipe cannot race a restore. */
  const historyChainRef = useRef<Promise<void>>(Promise.resolve());
  /** Latest records/retention for queued history jobs (avoid stale closures). */
  const historySnapshotRef = useRef({
    records: state.records,
    retention: state.settings.transcriptRetention,
  });
  historySnapshotRef.current = {
    records: state.records,
    retention: state.settings.transcriptRetention,
  };
  /**
   * True from the moment the UI enters Off before settings.json confirms Off,
   * until that Off is confirmed (wipe) or abandoned (reload from disk). While
   * set, in-memory records are Off-filtered but history.json still holds the
   * pre-Off rows, so no snapshot save may run. Survives switching away from
   * Off: leaving a pending Off must not persist the filtered list.
   */
  const historyDivergedRef = useRef(false);
  if (
    state.settings.transcriptRetention === 'off'
    && lastSavedSettingsRef.current?.settings.transcriptRetention !== 'off'
  ) {
    historyDivergedRef.current = true;
  }
  /**
   * While reloadHistoryFromDisk awaits load, deletes must not be undone by the
   * merge. Null when no reload is in flight.
   */
  const reloadDeletedIdsRef = useRef<Set<string> | null>(null);

  const dictionaryHydratedRef = useRef(!dictionaryPers.enabled);
  const allowDictionaryPersistRef = useRef(!dictionaryPers.enabled);
  const dictionaryPersistGenRef = useRef(0);
  /** Last successfully saved words — roll back UI on save failure. */
  const lastSavedWordsRef = useRef<string[] | null>(null);

  const enqueueHistoryJob = (job: () => Promise<void>) => {
    historyChainRef.current = historyChainRef.current.then(job, job);
  };

  /** Memory is Off-filtered but history.json not yet wiped (Off pending or abandoned). */
  const retentionOffPending = () => historyDivergedRef.current;

  const saveHistorySnapshot = async () => {
    if (!historyPers.enabled || !historyHydratedRef.current || !allowHistoryPersistRef.current) {
      return;
    }
    // Leave history.json alone until Off is confirmed on settings.json.
    if (retentionOffPending()) return;
    const gen = historyPersistGenRef.current;
    const { records, retention } = historySnapshotRef.current;
    try {
      await historyPers.store.save(records, retention, clock());
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
  };

  const reloadHistoryFromDisk = async (retention: typeof state.settings.transcriptRetention) => {
    if (!historyPers.enabled || !historyHydratedRef.current) return;
    // Supersede any in-flight wipe: bump gen, then load after prior jobs finish.
    historyPersistGenRef.current += 1;
    const gen = historyPersistGenRef.current;
    const deletedDuringReload = new Set<string>();
    reloadDeletedIdsRef.current = deletedDuringReload;
    try {
      const result = await historyPers.store.load(retention, clock());
      if (gen !== historyPersistGenRef.current) return;
      if (result.ok) {
        // Prefer in-memory for shared ids (live edits / deletes already applied).
        // Drop ids deleted while load was in flight so an explicit Delete is not
        // undone. Memory-only rows added during the load stay first; disk order
        // is preserved for restored rows.
        const current = historySnapshotRef.current.records;
        const diskIds = new Set(result.records.map((record) => record.id));
        const memoryById = new Map(
          current
            .filter((record) => !deletedDuringReload.has(record.id))
            .map((record) => [record.id, record]),
        );
        const memoryOnly = current.filter(
          (record) => !deletedDuringReload.has(record.id) && !diskIds.has(record.id),
        );
        const fromDisk = result.records
          .filter((record) => !deletedDuringReload.has(record.id))
          .map((record) => memoryById.get(record.id) ?? record);
        const merged = [...memoryOnly, ...fromDisk];
        historyDivergedRef.current = false;
        // Queued saves run before React re-renders; give them the merged list.
        historySnapshotRef.current = { ...historySnapshotRef.current, records: merged };
        dispatch({ now: clock(), records: merged, type: 'hydrate-records' });
        dispatch({ message: null, type: 'set-history-error' });
      } else {
        dispatch({
          message: result.error,
          sticky: true,
          type: 'set-history-error',
        });
      }
    } finally {
      if (reloadDeletedIdsRef.current === deletedDuringReload) {
        reloadDeletedIdsRef.current = null;
      }
    }
  };

  const patchHistoryDeleteOnDisk = async (id: string) => {
    if (!historyPers.enabled || !historyHydratedRef.current || !allowHistoryPersistRef.current) {
      return;
    }
    if (!retentionOffPending()) return;
    const diskRetention = lastSavedSettingsRef.current?.settings.transcriptRetention ?? 'forever';
    if (diskRetention === 'off') return;
    const gen = historyPersistGenRef.current;
    try {
      const loaded = await historyPers.store.load(diskRetention, clock());
      if (gen !== historyPersistGenRef.current || !loaded.ok) return;
      const next = loaded.records.filter((record) => record.id !== id);
      await historyPers.store.save(next, diskRetention, clock());
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
  };

  /**
   * settings.json now holds `retention` (confirmed save or rollback target).
   * Only acts when a local Off transition left memory ahead of disk:
   * Off confirmed → wipe history.json; Off abandoned → reload pre-Off rows.
   * Any other save/rollback leaves history alone (no reload while already Off).
   */
  const settleRetentionOff = (retention: typeof state.settings.transcriptRetention) => {
    if (!historyDivergedRef.current) {
      if (retention === 'off') enqueueHistoryJob(() => saveHistorySnapshot());
      return;
    }
    if (retention === 'off') {
      historyDivergedRef.current = false;
      enqueueHistoryJob(() => saveHistorySnapshot());
    } else {
      enqueueHistoryJob(() => reloadHistoryFromDisk(retention));
    }
  };

  const history = useMemo(() => ({
    delete: (id: string) => {
      historyDispatch.delete(id);
      // Tombstone for an in-flight failed-Off reload merge (prefer memory /
      // drop deleted ids so Delete is not silently undone).
      reloadDeletedIdsRef.current?.add(id);
      // While Off is optimistic, memory no longer mirrors disk — patch disk so a
      // failed Off save + reload cannot revive a row the user just deleted.
      enqueueHistoryJob(() => patchHistoryDeleteOnDisk(id));
    },
  }), [historyDispatch]);

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
            now: Date.now(), type: 'hydrate-settings',
          });
          lastSavedSettingsRef.current = result.file;
          lastRequestedSettingsRef.current = result.file;
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
          // Defaults, or the parsed values of a file this window may not
          // migrate (Settings window, BUS-42) so it shows the real values.
          dispatch({
            onboardingComplete: result.file.onboardingComplete,
            settings: result.file.settings,
            now: Date.now(), type: 'hydrate-settings',
          });
          lastSavedSettingsRef.current = result.file;
          lastRequestedSettingsRef.current = result.file;
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
        dispatch({ records: historyResult.records, now: Date.now(), type: 'hydrate-records' });
        allowHistoryPersistRef.current = false;
        dispatch({
          message: settingsBlocked
            ? 'History is read-only until settings can be read. Your history file was left untouched.'
            : 'History is read-only because it couldn\'t be backed up after settings were reset. Your history file was left untouched.',
          sticky: true,
          type: 'set-history-error',
        });
      } else if (historyResult.ok) {
        dispatch({ records: historyResult.records, now: Date.now(), type: 'hydrate-records' });
        allowHistoryPersistRef.current = true;
      } else {
        // Unreadable / unknown-version history.json: never write over it
        // (the store already tried to back it up). BUS-42. Dictations made
        // before this load stay visible in memory but are never written.
        dispatch({ records: [], now: Date.now(), type: 'hydrate-records' });
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

  useSettingsSync({
    allowRef: allowSettingsPersistRef,
    current: { onboardingComplete: state.onboarding.complete, settings: state.settings },
    dispatch,
    enabled: settingsPers.enabled,
    lastRequestedRef: lastRequestedSettingsRef,
    lastSavedRef: lastSavedSettingsRef,
    persistGenRef: settingsPersistGenRef,
  });

  useSettingsPersist({
    allowRef: allowSettingsPersistRef,
    dispatch,
    hydratedRef: settingsHydratedRef,
    lastRequestedRef: lastRequestedSettingsRef,
    lastSavedRef: lastSavedSettingsRef,
    onboardingComplete: state.onboarding.complete,
    onRolledBack: (file) => settleRetentionOff(file.settings.transcriptRetention),
    onSaved: (file) => settleRetentionOff(file.settings.transcriptRetention),
    persistence: settingsPers,
    persistGenRef: settingsPersistGenRef,
    settings: state.settings,
  });

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

  // Persist history after hydrate whenever records or retention change.
  // Writes are serialized. Optimistic Retention Off skips the wipe until
  // settings.json confirms Off (onSaved); foreign Off already updated
  // lastSavedSettingsRef before hydrate, so the wipe runs here.
  useEffect(() => {
    enqueueHistoryJob(() => saveHistorySnapshot());
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
