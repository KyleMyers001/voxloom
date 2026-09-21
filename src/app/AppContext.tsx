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
}

export function AppProvider({
  children,
  clock = Date.now,
  historyPersistence,
}: AppProviderProps) {
  const persistence = useMemo(
    () => historyPersistence ?? createDefaultHistoryStore(),
    [historyPersistence],
  );
  const [state, dispatch] = useReducer(
    appReducer,
    clock(),
    (now) => createInitialState(now, {
      persistHistory: persistence.enabled,
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

  const hydratedRef = useRef(!persistence.enabled);
  /** False after a corrupt-load so we never overwrite the broken file. */
  const allowPersistRef = useRef(!persistence.enabled);
  const persistGenRef = useRef(0);

  // Boot: load durable history into state.records (fail-safe on corrupt).
  useEffect(() => {
    if (!persistence.enabled) {
      hydratedRef.current = true;
      allowPersistRef.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await persistence.store.load(
        // Retention comes from initial settings until hydrate; default is
        // 30-days in fixtures — re-read after settings load if that lands.
        state.settings.transcriptRetention,
        clock(),
      );
      if (cancelled) return;
      if (result.ok) {
        dispatch({ records: result.records, type: "hydrate-records" });
        allowPersistRef.current = true;
      } else {
        // Do not wipe on-disk file; keep in-memory empty list + surface error.
        allowPersistRef.current = false;
        dispatch({
          message: result.error,
          type: "set-history-error",
        });
      }
      hydratedRef.current = true;
      persistGenRef.current += 1;
    })();
    return () => {
      cancelled = true;
    };
    // Intentional once-on-mount boot load (persistence identity is stable).
  }, [persistence]);

  // Persist after a successful hydrate whenever records or retention change.
  useEffect(() => {
    if (!persistence.enabled || !hydratedRef.current || !allowPersistRef.current) {
      return;
    }
    const gen = persistGenRef.current;
    void (async () => {
      try {
        await persistence.store.save(
          state.records,
          state.settings.transcriptRetention,
          clock(),
        );
        if (gen !== persistGenRef.current) return;
        dispatch({ message: null, type: "set-history-error" });
      } catch (error: unknown) {
        if (gen !== persistGenRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        dispatch({
          message: `Failed to save history: ${message}`,
          type: "set-history-error",
        });
      }
    })();
  }, [
    clock,
    persistence,
    state.records,
    state.settings.transcriptRetention,
  ]);

  const value = {
    clipboard,
    dictation,
    dictionary,
    dispatch,
    history,
    historyDurable: persistence.enabled,
    now: clock,
    settings,
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
