import type { DogfoodResult } from '../../src/services/stt/dogfoodPath';
import { describe, expect, it, vi } from 'vitest';
import { createGuidedSetup, type SetupBoundary } from '../../src/features/onboarding/guidedSetup';
import { SttError } from '../../src/services/stt/types';

const authorized = { microphone: 'authorized', accessibility: 'authorized' } as const;
export function boundary(): SetupBoundary {
  return {
    query: vi.fn().mockResolvedValue(authorized),
    request: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn().mockResolvedValue(undefined),
    readiness: vi.fn().mockResolvedValue({ modelId: 'whisper-base.en', ready: true, reason: null }),
    download: vi.fn().mockResolvedValue(undefined),
    cancelDownload: vi.fn().mockResolvedValue(undefined),
    activeShortcut: () => 'Ctrl + Shift + Space',
    native: true,
  };
}

describe('guided setup lifecycle', () => {
  it('re-reads both result gates after the final asynchronous check instead of trusting stale Ready UI', async () => {
    const io = boundary();
    let id = 'whisper-base.en';
    const setup = createGuidedSetup(io, () => id, () => 'Ctrl + Shift + Space', { read: () => JSON.stringify({ version: 1, step: 4, holdDone: true, tapDone: true, modelId: id, shortcut: 'Ctrl + Shift + Space' }), write: vi.fn() });
    let resume!: (value: { modelId: string; ready: boolean; reason: null }) => void;
    io.readiness = () => new Promise((resolve) => { resume = resolve; });
    const finished = setup.finish();
    id = 'whisper-tiny.en';
    resume({ modelId: 'whisper-base.en', ready: true, reason: null });
    expect(await finished).toBe(false);
  });
  it('resumes an already running native download without starting another and observes verified completion', async () => {
    const io = boundary();
    let downloading = true;
    io.modelStatus = async () => ({ id: 'whisper-base.en', label: 'Whisper Base (English)', sizeBytes: 147964211, status: downloading ? 'downloading' : 'available' });
    io.readiness = async () => ({ modelId: 'whisper-base.en', ready: !downloading, reason: downloading ? 'Downloading' : null });
    const setup = createGuidedSetup(io, () => 'whisper-base.en', () => 'Ctrl + Shift + Space');
    await setup.refresh();
    expect(setup.getSnapshot().downloading).toBe('whisper-base.en');
    expect(setup.getSnapshot().ready).toBe(false);
    await setup.start();
    expect(io.download).not.toHaveBeenCalled();
    downloading = false;
    await setup.refresh();
    expect(setup.getSnapshot()).toMatchObject({ downloading: null, ready: true });
  });
  it('retires both tries when the accepted shortcut or selected model changes instead of mixing tutorial configurations', async () => {
    const io = boundary();
    let shortcut = 'Ctrl + Shift + Space';
    let id = 'whisper-base.en';
    io.activeShortcut = () => shortcut;
    io.readiness = async (modelId) => ({ modelId, ready: true, reason: null });
    const storage = { read: () => JSON.stringify({ version: 1, step: 4, holdDone: true, tapDone: true, mode: 'tap', modelId: id, shortcut }), write: vi.fn() };
    const setup = createGuidedSetup(io, () => id, () => shortcut, storage);
    expect(setup.getSnapshot().holdDone).toBe(true);
    shortcut = 'Ctrl + Alt + K';
    await setup.refresh();
    expect(setup.getSnapshot()).toMatchObject({ step: 3, holdDone: false, tapDone: false, mode: 'hold' });
    id = 'whisper-tiny.en';
    await setup.refresh();
    expect(setup.getSnapshot().ready).toBe(true);
  });
  it('rechecks permission after slow model verification and fails closed on incomplete permission replies', async () => {
    const io = boundary();
    let allowed = true;
    let resume!: () => void;
    io.readiness = async () => { await new Promise<void>((resolve) => { resume = resolve; }); return { modelId: 'whisper-base.en', ready: true, reason: null }; };
    io.query = async () => ({ ...authorized, microphone: allowed ? 'authorized' : 'denied' });
    const setup = createGuidedSetup(io, () => 'whisper-base.en', () => 'Ctrl + Shift + Space');
    const pending = setup.refresh();
    allowed = false; resume();
    expect(await pending).toBe(false);
    io.readiness = async () => ({ modelId: 'whisper-base.en', ready: true, reason: null });
    io.query = async () => ({}) as Awaited<ReturnType<SetupBoundary['query']>>;
    expect(await setup.refresh()).toBe(false);
  });
  it('cannot advance from connected on a stale model check or revive a lease after a failed recheck', async () => {
    const io = boundary();
    let id = 'whisper-base.en';
    const setup = createGuidedSetup(io, () => id, () => 'Ctrl + Shift + Space');
    await setup.start();
    let resume!: (value: { modelId: string; ready: boolean; reason: null }) => void;
    io.readiness = () => new Promise((resolve) => { resume = resolve; });
    const next = setup.next();
    id = 'whisper-tiny.en';
    resume({ modelId: 'whisper-base.en', ready: true, reason: null });
    expect(await next).toBe(false);
    expect(setup.getSnapshot().step).toBe(1);
    io.readiness = async () => ({ modelId: id, ready: true, reason: null });
    await setup.next(); await setup.next();
    const lease = await setup.begin('hold');
    io.query = async () => { throw new Error('Lost permission IPC'); };
    await setup.refresh();
    io.query = async () => authorized;
    await setup.refresh();
    expect(setup.current(lease!)).toBe(false);
  });
  it('revocation retires a practice lease permanently and a failed download keeps actionable recovery copy', async () => {
    const io = boundary();
    const setup = createGuidedSetup(io, () => 'whisper-base.en', () => 'Ctrl + Shift + Space');
    await setup.start(); await setup.next(); await setup.next();
    const lease = await setup.begin('hold');
    io.query = async () => ({ ...authorized, microphone: 'denied' });
    await setup.refresh();
    io.query = async () => authorized;
    await setup.refresh();
    expect(setup.current(lease!)).toBe(false);
    io.download = async () => { throw new Error('Disk full'); };
    io.readiness = async () => ({ modelId: 'whisper-base.en', ready: false, status: 'missing', reason: 'not verified' });
    await setup.download();
    expect(setup.getSnapshot().error).toContain('Disk full');
  });
  it('reports a user-cancelled download neutrally rather than as a failure', async () => {
    const io = boundary();
    io.download = async () => { throw new SttError('cancelled', 'Download cancelled: whisper-base.en'); };
    io.readiness = async () => ({ modelId: 'whisper-base.en', ready: false, status: 'missing', reason: 'not verified' });
    const setup = createGuidedSetup(io, () => 'whisper-base.en', () => 'Ctrl + Shift + Space');
    await setup.download();
    expect(setup.getSnapshot().error).toBe('Download cancelled. Nothing unverified is used. Choose Retry download when you’re ready.');
    expect(setup.getSnapshot()).toMatchObject({ downloading: null, modelReady: false, ready: false });
  });
  it('persists unfinished steps and both results without persisting readiness or transcript', async () => {
    let saved = '';
    const storage = { read: () => saved, write: (value: string) => { saved = value; } };
    const setup = createGuidedSetup(boundary(), () => 'whisper-base.en', () => 'Ctrl + Shift + Space', storage);
    await setup.start();
    await setup.next();
    expect(setup.getSnapshot().step).toBe(2);
    expect(saved).not.toContain('ready');
    expect(saved).not.toContain('permissions');
    const resumed = createGuidedSetup(boundary(), () => 'whisper-base.en', () => 'Ctrl + Shift + Space', storage);
    expect(resumed.getSnapshot().step).toBe(2);
    expect(resumed.getSnapshot().ready).toBe(false);
    resumed.back();
    expect(resumed.getSnapshot().step).toBe(1);
    expect(resumed.getSnapshot().holdDone).toBe(false);
  });
  it('clears saved progress on completion and a later readiness check never resurrects it', async () => {
    const shortcut = 'Ctrl + Shift + Space';
    let saved: string | null = JSON.stringify({ version: 1, step: 4, holdDone: true, tapDone: true, mode: 'tap', modelId: 'whisper-base.en', shortcut });
    const storage = { read: () => saved, write: (value: string) => { saved = value; }, clear: () => { saved = null; } };
    const setup = createGuidedSetup(boundary(), () => 'whisper-base.en', () => shortcut, storage);
    expect(await setup.finish()).toBe(true);
    setup.clearProgress();
    expect(saved).toBeNull();
    await setup.refresh();
    expect(saved).toBeNull();
    expect(createGuidedSetup(boundary(), () => 'whisper-base.en', () => shortcut, storage).getSnapshot())
      .toMatchObject({ step: 0, holdDone: false, tapDone: false, mode: 'hold' });
  });
  it('counts only both owned real insertion results, retaining hold through cancellation and retry', async () => {
    const setup = createGuidedSetup(boundary(), () => 'whisper-base.en', () => 'Ctrl + Shift + Space');
    await setup.start();
    await setup.next();
    await setup.next();
    const field = document.createElement('textarea');
    document.body.append(field);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    field.focus();
    const result = (text: string, status = 'inserted') => ({ transcript: { text }, delivery: { text, status, detail: 'Voxloom field' } }) as DogfoodResult;
    const hold = await setup.begin('hold');
    expect(hold).not.toBeNull();
    expect(setup.getSnapshot().holdDone).toBe(false);
    expect(setup.insert(hold!, 'Spoken words', field)).toBe(true);
    setup.result(hold!, result('Spoken words', 'copied'));
    expect(setup.getSnapshot().holdDone).toBe(false);
    setup.result(hold!, result('Spoken words'));
    expect(setup.getSnapshot().holdDone).toBe(true);
    setup.tryHandsFree();
    const cancelled = await setup.begin('tap');
    setup.cancelPractice();
    expect(setup.insert(cancelled!, 'late words', field)).toBe(false);
    setup.result(cancelled!, result('late words'));
    expect(setup.getSnapshot().tapDone).toBe(false);
    expect(setup.getSnapshot().holdDone).toBe(true);
    const tap = await setup.begin('tap');
    expect(setup.insert(tap!, 'Hands free words', field)).toBe(true);
    setup.result(tap!, result('Hands free words'));
    expect(await setup.next()).toBe(true);
    expect(setup.getSnapshot().step).toBe(4);
    field.remove();
    vi.restoreAllMocks();
  });
  it('rejects stale readiness across model changes, permission revocation and unresolved registration', async () => {
    const io = boundary();
    let id = 'whisper-base.en';
    let resolve!: (value: { modelId: string; ready: boolean; reason: null }) => void;
    io.readiness = () => new Promise((done) => { resolve = done; });
    const setup = createGuidedSetup(io, () => id, () => 'Ctrl + Shift + Space');
    const pending = setup.refresh();
    id = 'whisper-tiny.en';
    resolve({ modelId: 'whisper-base.en', ready: true, reason: null });
    await pending;
    expect(setup.getSnapshot().ready).toBe(false);
    io.readiness = async () => ({ modelId: id, ready: true, reason: null });
    io.activeShortcut = () => undefined;
    expect(await setup.refresh()).toBe(false);
    io.activeShortcut = () => 'Ctrl + Shift + Space';
    expect(await setup.refresh()).toBe(true);
    io.query = async () => ({ ...authorized, accessibility: 'not-granted' });
    expect(await setup.refresh()).toBe(false);
  });
  it('keeps a same-configuration verdict through a background recheck between validate and result', async () => {
    const io = boundary();
    const setup = createGuidedSetup(io, () => 'whisper-base.en', () => 'Ctrl + Shift + Space');
    await setup.start(); await setup.next(); await setup.next();
    const field = document.createElement('textarea');
    document.body.append(field);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    field.focus();
    const lease = await setup.begin('hold');
    // The delivery guard's validate(): a fresh check confirms the lease.
    expect((await setup.refresh()) && setup.current(lease!)).toBe(true);
    // Window focus, visibility or models-changed rechecks before insertion.
    let resume!: (value: { modelId: string; ready: boolean; reason: null }) => void;
    io.readiness = () => new Promise((resolve) => { resume = resolve; });
    const background = setup.refresh();
    expect(setup.getSnapshot()).toMatchObject({ ready: true, modelReady: true, modelState: 'available', checking: true });
    expect(setup.insert(lease!, 'Spoken words', field)).toBe(true);
    setup.result(lease!, { transcript: { text: 'Spoken words' }, delivery: { text: 'Spoken words', status: 'inserted', detail: 'Voxloom field' } } as DogfoodResult);
    expect(setup.getSnapshot().holdDone).toBe(true);
    resume({ modelId: 'whisper-base.en', ready: true, reason: null });
    expect(await background).toBe(true);
    expect(setup.getSnapshot()).toMatchObject({ ready: true, checking: false, holdDone: true });
    field.remove();
    vi.restoreAllMocks();
  });
  it('drops readiness at once when a recheck follows a model change and retires a lease on a failed recheck', async () => {
    const io = boundary();
    let id = 'whisper-base.en';
    io.readiness = async (modelId) => ({ modelId, ready: true, reason: null });
    const setup = createGuidedSetup(io, () => id, () => 'Ctrl + Shift + Space');
    await setup.start(); await setup.next(); await setup.next();
    const lease = await setup.begin('hold');
    let resume!: (value: { modelId: string; ready: boolean; reason: null }) => void;
    io.readiness = () => new Promise((resolve) => { resume = resolve; });
    io.query = async () => ({ ...authorized, microphone: 'denied' });
    const revoked = setup.refresh();
    expect(setup.current(lease!)).toBe(true);
    resume({ modelId: id, ready: true, reason: null });
    expect(await revoked).toBe(false);
    expect(setup.current(lease!)).toBe(false);
    io.readiness = async (modelId) => ({ modelId, ready: true, reason: null });
    io.query = async () => authorized;
    expect(await setup.refresh()).toBe(true);
    io.readiness = () => new Promise(() => {});
    id = 'whisper-tiny.en';
    void setup.refresh();
    expect(setup.getSnapshot()).toMatchObject({ ready: false, modelReady: false, modelState: 'pending', checking: true });
  });
  it('discloses then downloads only on explicit Start while querying all prerequisites without prompting', async () => {
    const io = boundary();
    vi.mocked(io.readiness).mockResolvedValue({ modelId: 'whisper-base.en', ready: false, status: 'missing', reason: 'Missing' });
    vi.mocked(io.download).mockImplementation(async () => {
      vi.mocked(io.readiness).mockResolvedValue({ modelId: 'whisper-base.en', ready: true, reason: null });
    });
    const setup = createGuidedSetup(io, () => 'whisper-base.en', () => 'Ctrl + Shift + Space');
    await setup.refresh();
    expect(io.download).not.toHaveBeenCalled();
    expect(io.request).not.toHaveBeenCalled();
    expect(setup.getSnapshot().step).toBe(0);
    await setup.start();
    expect(io.download).toHaveBeenCalledWith('whisper-base.en', expect.any(Function));
    expect(setup.getSnapshot().step).toBe(1);
    expect(setup.getSnapshot().ready).toBe(true);
  });
});
