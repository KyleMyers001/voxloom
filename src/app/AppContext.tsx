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
import { appReducer, createInitialState, type AppAction, type AppState } from
  "./state";

interface AppContextValue {
  clipboard: ClipboardAdapter;
  dispatch: Dispatch<AppAction>;
  now: () => number;
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
  const value = { clipboard, dispatch, now: clock, state };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
