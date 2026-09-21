import {
  createRecords,
  initialOnboarding,
  initialSettings,
} from "../domain/fixtures";
import type { AppState } from "./state";

export interface InitialStateOptions {
  /**
   * When true (Tauri shell with durable history), start with an empty
   * record list so fixture seed data does not flash or overwrite disk
   * before hydrate completes.
   */
  persistHistory?: boolean;
}

export function createInitialState(
  now: number,
  options: InitialStateOptions = {},
): AppState {
  return {
    clipboardFailure: false,
    dictation: { kind: "ready" },
    historyError: null,
    nextRunId: 1,
    onboarding: { ...initialOnboarding },
    records: options.persistHistory ? [] : createRecords(now),
    screen: "home",
    settings: { ...initialSettings },
    words: ["JSON", "Postgres", "TanStack Query", "TypeScript"],
  };
}
