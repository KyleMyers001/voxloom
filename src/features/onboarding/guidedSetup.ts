import { SttError, type SttDownloadProgress, type SttModelInfo } from '../../services/stt/types';
import { insertIntoOwnField } from '../../services/delivery/ownField';
import type { DogfoodResult } from '../../services/stt/dogfoodPath';

export interface PracticeLease { id: number; mode: 'hold' | 'tap'; model: string; shortcut: string }
export interface SetupProgressStorage { read(): string | null; write(value: string): void; clear?(): void }

export type PermissionKind = 'microphone' | 'accessibility';
export type PermissionState = 'authorized' | 'not-determined' | 'denied' | 'restricted' | 'not-granted' | 'unknown' | 'unsupported';
export interface Permissions { microphone: PermissionState; accessibility: PermissionState }
export type SetupModelState = 'pending' | 'missing' | 'available' | 'downloading' | 'unavailable';
export interface ModelReadiness { modelId: string; ready: boolean; reason: string | null; status?: SetupModelState }
export interface SetupBoundary {
  native: boolean;
  query(): Promise<Permissions>;
  request(kind: PermissionKind): Promise<unknown>;
  openSettings(kind: PermissionKind): Promise<void>;
  readiness(modelId: string): Promise<ModelReadiness>;
  modelStatus?(modelId: string): Promise<SttModelInfo | null>;
  download(modelId: string, onProgress: (progress: SttDownloadProgress) => void): Promise<void>;
  cancelDownload(modelId: string): Promise<void>;
  activeShortcut(): string | null | undefined;
}
export interface GuidedState {
  step: number;
  permissions: Permissions;
  ready: boolean;
  modelReady: boolean;
  modelState: SetupModelState;
  checking: boolean;
  error: string | null;
  downloading: string | null;
  progress: SttDownloadProgress | null;
  holdDone: boolean;
  tapDone: boolean;
  mode: 'hold' | 'tap';
}
const unknown: Permissions = { microphone: 'unknown', accessibility: 'unknown' };
export function permissionsAuthorized(value: Permissions): boolean {
  return value?.microphone === 'authorized' && value?.accessibility === 'authorized';
}

/** Setup authority: readiness is ephemeral; persisted progress never grants it. */
export function createGuidedSetup(io: SetupBoundary, modelId: () => string, shortcut: () => string, storage?: SetupProgressStorage) {
  let state: GuidedState = { step: 0, permissions: unknown, ready: false, modelReady: false, modelState: 'pending', checking: false, error: null, downloading: null, progress: null, holdDone: false, tapDone: false, mode: 'hold' };
  try {
    const saved = JSON.parse(storage?.read() ?? 'null');
    if (saved?.version === 1 && Number.isInteger(saved.step) && saved.step >= 0 && saved.step <= 4) {
      state.step = saved.step;
      state.holdDone = saved.modelId === modelId() && saved.shortcut === shortcut() && saved.holdDone === true;
      state.tapDone = state.holdDone && saved.tapDone === true;
      state.mode = state.holdDone && saved.mode === 'tap' ? 'tap' : 'hold';
      if (state.step === 4 && (!state.holdDone || !state.tapDone)) state.step = 3;
    }
  } catch { /* Unreadable progress resumes safely at Welcome. */ }
  const listeners = new Set<() => void>();
  let generation = 0;
  let checkedModel: string | null = null;
  let verdictFor: string | null = null;
  let pendingCheck: { id: string; binding: string; promise: Promise<boolean> } | null = null;
  let practicedModel = modelId();
  let practicedShortcut = shortcut();
  let ownedDownload: string | null = null;
  let attempt = 0;
  let lease: PracticeLease | null = null;
  let inserted: { lease: PracticeLease; text: string; field: HTMLTextAreaElement; value: string } | null = null;
  const cancelPractice = () => { attempt++; lease = null; inserted = null; };
  const current = (owned: PracticeLease) => lease === owned && owned.id === attempt
    && state.step === 3 && owned.model === modelId() && owned.shortcut === shortcut()
    && io.activeShortcut() === owned.shortcut;
  const progress = () => JSON.stringify({ version: 1, step: state.step, holdDone: state.holdDone, tapDone: state.tapDone, mode: state.mode, modelId: practicedModel, shortcut: practicedShortcut });
  let saved: string | null = null;
  const patch = (changes: Partial<GuidedState>) => {
    state = { ...state, ...changes };
    // Readiness-only patches never rewrite progress, so a late check cannot resurrect cleared progress.
    const value = progress();
    if (value !== saved) {
      try { storage?.write(value); saved = value; }
      catch { state.error = 'Setup progress could not be saved. Keep this window open or repeat setup next time.'; }
    }
    listeners.forEach((fn) => fn());
  };
  const refresh = () => {
    const id = modelId();
    const binding = shortcut();
    if (practicedModel !== id || practicedShortcut !== binding) {
      cancelPractice();
      practicedModel = id; practicedShortcut = binding;
      patch({ holdDone: false, tapDone: false, mode: 'hold', step: state.step === 4 ? 3 : state.step });
    }
    // A pending hash is not a missing model. Share the current configuration's
    // check, but never let an old model/binding verdict authorize a successor.
    if (pendingCheck?.id === id && pendingCheck.binding === binding) return pendingCheck.promise;
    const own = ++generation;
    checkedModel = null;
    // A background recheck of the same model/binding keeps the last verdict
    // until it resolves (a failed one still retires the lease), so it cannot
    // fail or uncredit an in-flight practice. A new configuration never inherits it.
    const config = `${id}\n${binding}`;
    patch(verdictFor === config ? { checking: true } : { ready: false, modelReady: false, modelState: 'pending', checking: true });
    const promise = (async () => {
      try {
        const model = await io.readiness(id);
        const status = await io.modelStatus?.(id);
        // Query OS permission after any slow model hash, not before it.
        const permissions = await io.query();
        if (own !== generation || id !== modelId() || model.modelId !== id || binding !== shortcut()) return false;
        checkedModel = id;
        const downloading = ownedDownload ?? (status?.status === 'downloading' || model.status === 'downloading' ? id : null);
        const modelState: SetupModelState = !io.native || status?.supported === false || model.status === 'unavailable' ? 'unavailable'
          : downloading === id ? 'downloading' : model.ready ? 'available'
            : model.status ?? (status?.status === 'missing' || status?.status === 'failed' ? 'missing' : 'pending');
        const modelReady = model.ready === true && modelState === 'available';
        const ready = io.native && modelReady && permissionsAuthorized(permissions) && io.activeShortcut() === binding;
        if (!ready) cancelPractice();
        verdictFor = config;
        patch({ permissions, modelReady, modelState, ready, downloading, error: modelReady ? null : model.reason });
        return ready;
      } catch (error) {
        if (own === generation && id === modelId() && binding === shortcut()) {
          cancelPractice(); patch({ error: String(error), ready: false, modelReady: false, modelState: 'pending' });
        }
        return false;
      }
    })().finally(() => {
      if (own === generation) { pendingCheck = null; patch({ checking: false }); }
    });
    pendingCheck = { id, binding, promise };
    return promise;
  };
  const download = async () => {
    if (state.downloading || ownedDownload) return;
    const id = modelId();
    const binding = shortcut();
    await refresh();
    if (id !== modelId() || binding !== shortcut() || checkedModel !== id || !io.native
      || state.modelState !== 'missing' || state.downloading || ownedDownload) return;
    ownedDownload = id;
    let failure: string | null = null;
    cancelPractice();
    patch({ downloading: id, modelState: 'downloading', error: null, modelReady: false, ready: false });
    try { await io.download(id, (progress) => patch({ progress })); }
    catch (error) {
      failure = error instanceof SttError && error.code === 'cancelled'
        ? 'Download cancelled. Nothing unverified is used. Choose Retry download when you’re ready.'
        : `Download failed: ${String(error)}. Retry when network and disk space are available. Nothing unverified is used.`;
    }
    finally { ownedDownload = null; patch({ downloading: null, progress: null }); }
    await refresh();
    if (failure && id === modelId() && binding === shortcut()) patch({ error: failure });
  };
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh,
    finish: async () => (await refresh()) && state.step === 4 && state.holdDone && state.tapDone,
    cancelPractice,
    back: () => { cancelPractice(); patch({ step: Math.max(0, state.step - 1) }); },
    current,
    next: async () => {
      cancelPractice();
      const ready = await refresh();
      if (!ready && !(state.step === 1 && checkedModel === modelId() && io.native && state.modelReady && permissionsAuthorized(state.permissions))) return false;
      if (state.step === 3 && (!state.holdDone || !state.tapDone)) return false;
      patch({ step: Math.min(4, state.step + 1) });
      return true;
    },
    tryHandsFree: () => { if (state.holdDone) { cancelPractice(); patch({ mode: 'tap' }); } },
    begin: async (mode: 'hold' | 'tap') => {
      cancelPractice();
      const own = attempt;
      if (state.step !== 3 || mode !== state.mode || !(await refresh()) || own !== attempt) return null;
      lease = { id: own, mode, model: modelId(), shortcut: shortcut() };
      return lease;
    },
    insert: (owned: PracticeLease, text: string, field: HTMLTextAreaElement | null) => {
      if (!current(owned) || !state.ready || !text.trim() || !field?.isConnected
        || field.ownerDocument.activeElement !== field) return false;
      if (!insertIntoOwnField(text, field.ownerDocument)) return false;
      inserted = { lease: owned, text, field, value: field.value };
      return true;
    },
    result: (owned: PracticeLease, result: DogfoodResult) => {
      if (!current(owned) || !state.ready || !inserted || inserted.lease !== owned
        || inserted.text !== result.transcript.text || inserted.value !== inserted.field.value
        || result.delivery.status !== 'inserted' || result.delivery.detail !== 'Voxloom field'
        || !result.transcript.text.trim()) return;
      patch(owned.mode === 'hold' ? { holdDone: true } : { tapDone: true });
      cancelPractice();
    },
    download,
    /** Completion or skip: forget saved progress so a later reopen starts over. */
    clearProgress: () => {
      cancelPractice();
      saved = progress();
      try { storage?.clear?.(); } catch { /* Nothing resumable was readable either. */ }
    },
    start: async () => { patch({ step: 1 }); if (state.downloading) await refresh(); else await download(); },
  };
}
