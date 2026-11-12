import { expect, it, vi } from 'vitest';
import { createGuidedSetup, type SetupBoundary } from '../../src/features/onboarding/guidedSetup';

function boundary(): SetupBoundary {
  return {
    native: true, query: vi.fn().mockResolvedValue({ microphone: 'authorized', accessibility: 'authorized' }),
    readiness: vi.fn(async (modelId) => ({ modelId, ready: true, reason: null })),
    request: vi.fn(), openSettings: vi.fn(), download: vi.fn(), cancelDownload: vi.fn(), activeShortcut: () => 'Ctrl + Shift + Space',
  };
}

const id = 'whisper-base.en';
const shortcut = () => 'Ctrl + Shift + Space';

it.each(['start', 'download'] as const)('%s awaits and coalesces an installed model hash instead of redownloading', async (action) => {
  const io = boundary();
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  io.readiness = vi.fn(async (modelId) => { await pending; return { modelId, ready: true, reason: null }; });
  const setup = createGuidedSetup(io, () => id, shortcut);
  const checking = setup.refresh();
  const requested = setup[action]();
  const earlyDownloads = vi.mocked(io.download).mock.calls.slice();
  release();
  await Promise.all([checking, requested]);
  expect(earlyDownloads).toEqual([]);
  expect(io.download).not.toHaveBeenCalled();
  expect(io.readiness).toHaveBeenCalledTimes(1);
  expect(setup.getSnapshot()).toMatchObject({ modelReady: true, modelState: 'available' });
});

it('does not download a missing pack when its selected engine is unavailable, including Retry', async () => {
  const io = boundary();
  io.readiness = async (modelId) => ({ modelId, ready: false, status: 'unavailable' as const, reason: 'The selected speech engine is unavailable in this build or on this Mac.' });
  io.modelStatus = async () => ({ id, label: 'Base', sizeBytes: 147964211, status: 'missing', supported: true });
  const setup = createGuidedSetup(io, () => id, shortcut);
  await setup.start();
  await setup.download();
  expect(io.download).not.toHaveBeenCalled();
  expect(setup.getSnapshot()).toMatchObject({ modelReady: false, modelState: 'unavailable' });
});

it('does not interpret a completed pending readiness reply or permissive available listing as missing', async () => {
  const io = boundary();
  io.readiness = async (modelId) => ({ modelId, ready: false, status: 'pending' as const, reason: 'Verification pending' });
  io.modelStatus = async () => ({ id, label: 'Base', sizeBytes: 147964211, status: 'available' });
  const setup = createGuidedSetup(io, () => id, shortcut);
  await setup.start();
  await setup.download();
  expect(io.download).not.toHaveBeenCalled();
  expect(setup.getSnapshot()).toMatchObject({ modelReady: false, modelState: 'pending' });
});

it('fails closed on an unknown readiness reply rather than treating false as evidence of missing assets', async () => {
  const io = boundary();
  io.readiness = async (modelId) => ({ modelId, ready: false, reason: null });
  const setup = createGuidedSetup(io, () => id, shortcut);
  await setup.start();
  await setup.download();
  expect(io.download).not.toHaveBeenCalled();
  expect(setup.getSnapshot()).toMatchObject({ modelState: 'pending', modelReady: false });
});

it('allows rechecking after a synchronous readiness failure instead of retaining a settled pending check', async () => {
  const io = boundary();
  io.readiness = () => { throw new Error('IPC unavailable'); };
  const setup = createGuidedSetup(io, () => id, shortcut);
  expect(await setup.refresh()).toBe(false);
  io.readiness = vi.fn(async (modelId) => ({ modelId, ready: true, reason: null }));
  expect(await setup.refresh()).toBe(true);
  expect(io.readiness).toHaveBeenCalledOnce();
  expect(io.download).not.toHaveBeenCalled();
});

it('does not use a stale missing verdict after a model or shortcut changes while Start waits', async () => {
  const io = boundary();
  let selected = id;
  let binding = shortcut();
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  io.readiness = async (modelId) => { await pending; return { modelId, ready: false, reason: 'Missing' }; };
  const setup = createGuidedSetup(io, () => selected, () => binding);
  const starting = setup.start();
  selected = 'whisper-tiny.en';
  binding = 'Ctrl + Alt + K';
  release();
  await starting;
  expect(io.download).not.toHaveBeenCalled();
  expect(setup.getSnapshot().modelReady).toBe(false);
});
