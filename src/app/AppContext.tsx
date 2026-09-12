import {
  createContext,
  type Dispatch,
  type ReactNode,
  useContext,
  useMemo,
  useReducer,
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
  now: () => number;
  settings: SettingsStore;
  setup: SetupLifecycle;
  state: AppState;
}

const AppContext = createContext<AppContextValue | null>(null);

interface AppProviderProps {
  children: ReactNode;
  clock?: () => number;
}

export function AppProvider({ children, clock = Date.now }: AppProviderProps) {
  const [state, dispatch] = useReducer(appReducer, clock(), createInitialState);
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
  const value = {
    clipboard,
    dictation,
    dictionary,
    dispatch,
    history,
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
