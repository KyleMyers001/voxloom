import {
  createRecords,
  initialOnboarding,
  initialSettings,
} from "../domain/fixtures";
import type { AppState } from "./state";

export function createInitialState(now: number): AppState {
  return {
    clipboardFailure: false,
    dictation: { kind: "ready" },
    nextRunId: 1,
    onboarding: { ...initialOnboarding },
    records: createRecords(now),
    screen: "home",
    settings: { ...initialSettings },
    words: ["JSON", "Postgres", "TanStack Query", "TypeScript"],
  };
}
