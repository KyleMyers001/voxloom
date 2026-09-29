import type { DictationState } from './types';

export type DictationAction =
  | { runId: number; type: 'cancel' }
  | { recordId: string; runId: number; type: 'complete' }
  | { recordId: string; runId: number; type: 'fail' }
  | {
      completion: 'automatic' | 'held';
      runId: number;
      type: 'process';
    }
  | { runId: number; type: 'start' }
  | { type: 'reset' }
  | { type: 'speech'; waveform: 'silent' | 'speaking' };

function hasRun(state: DictationState): state is Exclude<
  DictationState,
  { kind: 'ready' }
> {
  return 'runId' in state;
}

export function dictationReducer(
  state: DictationState,
  action: DictationAction,
): DictationState {
  if (action.type === 'reset') return { kind: 'ready' };
  if (action.type === 'start' && state.kind !== 'listening' &&
      state.kind !== 'processing') {
    return { kind: 'listening', runId: action.runId, waveform: 'silent' };
  }
  if (action.type === 'speech' && state.kind === 'listening') {
    return { ...state, waveform: action.waveform };
  }
  if (action.type === 'process' && state.kind === 'listening' &&
      state.runId === action.runId) {
    return {
      completion: action.completion,
      kind: 'processing',
      runId: action.runId,
    };
  }
  if (action.type === 'cancel' && hasRun(state) &&
      state.runId === action.runId &&
      (state.kind === 'listening' || state.kind === 'processing')) {
    return { kind: 'cancelled', runId: state.runId };
  }
  if (action.type === 'complete' && state.kind === 'processing' &&
      state.runId === action.runId) {
    return {
      kind: 'success',
      recordId: action.recordId,
      runId: action.runId,
    };
  }
  if (action.type === 'fail' && state.kind === 'processing' &&
      state.runId === action.runId) {
    return { kind: 'error', recordId: action.recordId, runId: action.runId };
  }
  return state;
}
