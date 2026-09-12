import type { AppAction } from "../../app/state";
import type { DictationLifecycle } from "../contracts";

interface ServiceDependencies {
  dispatch: (action: AppAction) => void;
  now: () => number;
}

export function createMockDictationService({
  dispatch,
  now,
}: ServiceDependencies): DictationLifecycle {
  return {
    cancel: (runId) => dispatch({ runId, type: "cancel-dictation" }),
    complete: (runId) => dispatch({
      now: now(),
      runId,
      type: "complete-dictation",
    }),
    fail: (runId) => dispatch({
      now: now(),
      runId,
      type: "fail-dictation",
    }),
    finish: (runId) => dispatch({
      completion: "automatic",
      runId,
      type: "process-dictation",
    }),
    holdProcessing: (runId) => dispatch({
      completion: "held",
      runId,
      type: "process-dictation",
    }),
    retry: (recordId) => dispatch({
      id: recordId,
      now: now(),
      type: "retry",
    }),
    speech: (waveform) => dispatch({
      type: "set-waveform",
      value: waveform,
    }),
    start: () => dispatch({ type: "start-dictation" }),
  };
}
