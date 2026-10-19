// BUS-16 PR 2c: the Settings toggle is the only writer of the explicit
// cleanup opt-in, and it needs a verified model and a bundled worker.
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import type { Settings } from '../../src/domain/types';
import { CleanupSettings } from '../../src/features/settings/CleanupSettings';
import type { CleanupModelStore } from '../../src/services/cleanup/contracts';
import { CLEANUP_MODEL_ID, CLEANUP_MODEL_SHA256, type CleanupModelStatus } from '../../src/services/cleanup/types';
import { renderWithApp } from './testUtils';

const ready: CleanupModelStatus = {
  available: true, id: CLEANUP_MODEL_ID, runtimeAvailable: true, sha256: CLEANUP_MODEL_SHA256,
};

function store(...statuses: CleanupModelStatus[]): CleanupModelStore {
  const status = vi.fn();
  for (const next of statuses) status.mockResolvedValueOnce(next);
  status.mockResolvedValue(statuses.at(-1));
  return { importModel: vi.fn().mockResolvedValue(null), status };
}

let latest: Settings = initialSettings;
function Probe({ start }: { start?: Partial<Settings> }) {
  const { dispatch, state } = useApp();
  useEffect(() => {
    if (start) dispatch({ onboardingComplete: true, settings: { ...initialSettings, ...start }, type: 'hydrate-settings' });
  }, [dispatch, start]);
  latest = state.settings;
  return null;
}

function renderCleanup(modelStore: CleanupModelStore | undefined, isNative = true, start?: Partial<Settings>) {
  return renderWithApp(<><Probe start={start} /><CleanupSettings isNative={isNative} modelStore={modelStore} /></>);
}

const toggle = () => screen.getByRole('switch', { name: 'Clean up transcripts locally' });

describe('CleanupSettings', () => {
  it('turning cleanup on writes cleanupEnabled, the opt-in and the model', async () => {
    const user = userEvent.setup();
    renderCleanup(store(ready));
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle());
    expect(latest).toMatchObject({ cleanupEnabled: true, cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true });
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle());
    expect(latest).toMatchObject({ cleanupEnabled: false, cleanupOptIn: false });
  });

  it('shows a #24-era file (cleanupEnabled, no opt-in) as off', async () => {
    renderCleanup(store(ready), true, { cleanupEnabled: true, cleanupModelId: CLEANUP_MODEL_ID });
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(latest.cleanupEnabled).toBe(true);
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });

  it.each([
    ['no model', { ...ready, available: false }, /Not installed/],
    ['no worker', { ...ready, runtimeAvailable: false }, /doesn't include the cleanup worker/],
  ])('cannot turn on with %s', async (_label, status, note) => {
    renderCleanup(store(status));
    await waitFor(() => expect(screen.getByText(note)).toBeInTheDocument());
    expect(toggle()).toBeDisabled();
  });

  it('can always turn an active cleanup off, even when the worker went missing', async () => {
    const user = userEvent.setup();
    renderCleanup(store({ ...ready, runtimeAvailable: false }), true, {
      cleanupEnabled: true, cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true,
    });
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    expect(toggle()).toBeEnabled();
    await user.click(toggle());
    expect(latest).toMatchObject({ cleanupEnabled: false, cleanupOptIn: false });
  });

  it('imports a model, then rechecks its status', async () => {
    const user = userEvent.setup();
    const models = store({ ...ready, available: false }, ready);
    renderCleanup(models);
    await waitFor(() => expect(screen.getByText(/Not installed/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Import model…' }));
    expect(models.importModel).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText('Qwen3 0.6B is installed.')).toBeInTheDocument());
    expect(toggle()).toBeEnabled();
  });

  it('shows status and import errors without enabling cleanup', async () => {
    const user = userEvent.setup();
    const models = store(ready);
    vi.mocked(models.status).mockReset().mockRejectedValue(new Error('denied'));
    vi.mocked(models.importModel).mockRejectedValue(new Error('wrong file'));
    renderCleanup(models);
    await waitFor(() => expect(screen.getByText(/Couldn't check the cleanup model: denied/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Import model…' }));
    await waitFor(() => expect(screen.getByText(/wrong file/)).toBeInTheDocument());
    expect(toggle()).toBeDisabled();
  });

  it('rejects a malformed native status', async () => {
    renderCleanup({ importModel: vi.fn(), status: vi.fn().mockResolvedValue(undefined) });
    await waitFor(() => expect(screen.getByText(/unexpected status/)).toBeInTheDocument());
    expect(toggle()).toBeDisabled();
  });

  it('is off and has no model actions in the browser preview', async () => {
    const models = store(ready);
    renderCleanup(models, false);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Available in the desktop app.')).toBeInTheDocument();
    expect(toggle()).toBeDisabled();
    expect(models.status).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Import model…' })).not.toBeInTheDocument();
  });
});
