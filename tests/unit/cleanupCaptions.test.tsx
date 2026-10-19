// BUS-16 PR 2c: the writing-style captions use the same gate as the Local
// cleanup block (`cleanupShown`): no cleanup wording while it is hidden.
import { act, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import type { Settings } from '../../src/domain/types';
import { HomeHero } from '../../src/features/home/HomeHero';
import { CaptureTab } from '../../src/features/settings/CaptureTab';
import type { CleanupModelStore } from '../../src/services/cleanup/contracts';
import { CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, type CleanupModelStatus } from '../../src/services/cleanup/types';
import { renderWithApp } from './testUtils';

vi.mock('../../src/services/capture/useCaptureState', () => ({
  useCaptureState: () => ({
    captureReady: true, captureState: { kind: 'idle' }, deviceListError: null, devices: [],
    devicesLoading: false, permissionStatus: 'authorized', prepareDeviceChange: vi.fn(),
    refreshDevices: vi.fn(), requestMicPermission: vi.fn(), runMicTest: vi.fn(), stopMicTest: vi.fn(),
  }),
}));
vi.mock('../../src/services/capture/captureService', () => ({ isTauriEnv: vi.fn().mockReturnValue(true) }));

const status = (runtimeAvailable: boolean): CleanupModelStatus => ({
  available: true, id: CLEANUP_MODEL_ID, runtimeAvailable, sha256: CLEANUP_MODEL_SHA256,
});
const store = (next: CleanupModelStatus): CleanupModelStore => ({
  importModel: vi.fn(), status: vi.fn().mockResolvedValue(next),
});
const activeSettings = { cleanupEnabled: true, cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true };

function Start({ settings }: { settings?: Partial<Settings> }) {
  const { dispatch } = useApp();
  useEffect(() => {
    if (settings) dispatch({ onboardingComplete: true, settings: { ...initialSettings, ...settings }, type: 'hydrate-settings' });
  }, [dispatch, settings]);
  return null;
}

async function renderBoth(models: CleanupModelStore, settings?: Partial<Settings>) {
  renderWithApp(<>
    <Start settings={settings} />
    <HomeHero cleanupModelStore={models} isNative />
    <CaptureTab cleanupModelStore={models} onSetup={vi.fn()} />
  </>);
  await waitFor(() => expect(models.status).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.resolve(); });
}

const settingsHelp = () => screen.queryByText('Used by local cleanup');
const styleControl = () => screen.getByRole('radiogroup', { name: /^Style preference/ });

describe('writing-style captions, production build', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('without a worker: old Home caption, no Settings cleanup caption, no block', async () => {
    vi.stubEnv('DEV', false);
    await renderBoth(store(status(false)));
    expect(screen.getByText('Style preference · cleanup not available yet')).toBeInTheDocument();
    expect(screen.queryByText(/local cleanup/)).not.toBeInTheDocument();
    expect(settingsHelp()).not.toBeInTheDocument();
    expect(styleControl()).toHaveAccessibleName('Style preference');
    expect(screen.queryByText('Local cleanup')).not.toBeInTheDocument();
  });

  it('while the status is unreadable: same as no worker', async () => {
    vi.stubEnv('DEV', false);
    const failing: CleanupModelStore = { importModel: vi.fn(), status: vi.fn().mockRejectedValue(new Error('denied')) };
    await renderBoth(failing);
    expect(screen.getByText('Style preference · cleanup not available yet')).toBeInTheDocument();
    expect(settingsHelp()).not.toBeInTheDocument();
  });

  it('with a worker: new wording on both, and the block', async () => {
    vi.stubEnv('DEV', false);
    await renderBoth(store(status(true)));
    expect(screen.getByText('Style preference · local cleanup is off')).toBeInTheDocument();
    expect(settingsHelp()).toBeInTheDocument();
    expect(styleControl()).toHaveAccessibleName('Style preference · used by local cleanup');
    expect(screen.getByText('Local cleanup')).toBeInTheDocument();
  });

  it('cleanup already active without a worker: new wording on both, and the block', async () => {
    vi.stubEnv('DEV', false);
    await renderBoth(store(status(false)), activeSettings);
    expect(screen.getByText('Writing style · local cleanup on')).toBeInTheDocument();
    expect(settingsHelp()).toBeInTheDocument();
    expect(screen.getByText('Local cleanup')).toBeInTheDocument();
  });
});

describe('writing-style captions, dev build', () => {
  it('without a worker: new wording on both, and the block with its note', async () => {
    expect(import.meta.env.DEV).toBe(true);
    await renderBoth(store(status(false)));
    expect(screen.getByText('Style preference · local cleanup is off')).toBeInTheDocument();
    expect(settingsHelp()).toBeInTheDocument();
    expect(screen.getByText(/doesn't include the cleanup worker yet/)).toBeInTheDocument();
  });
});
