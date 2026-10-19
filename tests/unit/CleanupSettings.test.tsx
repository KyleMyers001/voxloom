// BUS-16 PR 2c: the Settings toggle is the only writer of the explicit
// cleanup opt-in, and it needs a verified model and a bundled worker.
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import type { Settings } from '../../src/domain/types';
import { CleanupSettings } from '../../src/features/settings/CleanupSettings';
import { useCleanupModel } from '../../src/features/settings/useCleanupModel';
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

function Harness({ isNative, modelStore }: { isNative: boolean; modelStore?: CleanupModelStore }) {
  return <CleanupSettings isNative={isNative} model={useCleanupModel(isNative, modelStore)} />;
}

function renderCleanup(modelStore: CleanupModelStore | undefined, isNative = true, start?: Partial<Settings>) {
  return renderWithApp(<><Probe start={start} /><Harness isNative={isNative} modelStore={modelStore} /></>);
}

const toggle = () => screen.getByRole('switch', { name: 'Clean up transcripts locally' });

describe('CleanupSettings', () => {
  it('turning cleanup on writes only the opt-in and the model; the legacy key is untouched', async () => {
    const user = userEvent.setup();
    renderCleanup(store(ready));
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle());
    expect(latest).toMatchObject({ cleanupEnabled: false, cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true });
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle());
    expect(latest).toMatchObject({ cleanupEnabled: false, cleanupOptIn: false });
  });

  it('shows the opt-in alone as on, whatever the legacy cleanupEnabled says', async () => {
    renderCleanup(store(ready), true, { cleanupEnabled: false, cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true });
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
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
  ])('dev build: cannot turn on with %s', async (_label, status, note) => {
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
    expect(latest).toMatchObject({ cleanupEnabled: true, cleanupOptIn: false });
  });

  it('imports a model and applies the status it returns, without another hash', async () => {
    const user = userEvent.setup();
    const models = store({ ...ready, available: false });
    vi.mocked(models.importModel).mockResolvedValue(ready);
    renderCleanup(models);
    await waitFor(() => expect(screen.getByText(/Not installed/)).toBeInTheDocument());
    const button = screen.getByRole('button', { name: 'Import model…' });
    await user.click(button);
    expect(models.importModel).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText('Qwen3 0.6B is installed.')).toBeInTheDocument());
    expect(toggle()).toBeEnabled();
    expect(models.status).toHaveBeenCalledOnce();
    // Focus stays on Import (aria-disabled while importing, never disabled).
    expect(button).toHaveFocus();
  });

  it('a cancelled picker changes nothing and reads nothing', async () => {
    const user = userEvent.setup();
    const models = store({ ...ready, available: false });
    renderCleanup(models);
    await waitFor(() => expect(screen.getByText(/Not installed/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Import model…' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import model…' })).toHaveAttribute('aria-disabled', 'false'));
    expect(models.status).toHaveBeenCalledOnce();
    expect(screen.getByText(/Not installed/)).toBeInTheDocument();
  });

  it('Import is aria-disabled while importing: it keeps focus and ignores clicks', async () => {
    const user = userEvent.setup();
    let finish!: (status: CleanupModelStatus) => void;
    const models = store({ ...ready, available: false });
    vi.mocked(models.importModel).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderCleanup(models);
    const button = await screen.findByRole('button', { name: 'Import model…' });
    await user.click(button);
    const busy = screen.getByRole('button', { name: 'Importing…' });
    expect(busy).toBe(button);
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).not.toBeDisabled();
    expect(busy).toHaveFocus();
    await user.click(busy);
    expect(models.importModel).toHaveBeenCalledOnce();
    expect(busy).toHaveFocus();
    // Check again is guarded the same way while importing.
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(models.status).toHaveBeenCalledOnce();
    act(() => { button.focus(); });
    await act(async () => { finish(ready); });
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'false');
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

  it.each([
    ['no status', undefined],
    ['a non-string id', { ...ready, id: 42 }],
    ['a missing id', { available: true, runtimeAvailable: true, sha256: CLEANUP_MODEL_SHA256 }],
  ])('rejects a malformed native status (%s)', async (_label, status) => {
    renderCleanup({ importModel: vi.fn(), status: vi.fn().mockResolvedValue(status) });
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

describe('CleanupSettings in a production build', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const prod = () => vi.stubEnv('DEV', false);
  const block = () => screen.queryByText('Local cleanup');

  it('renders nothing without a bundled worker', async () => {
    prod();
    const models = store({ ...ready, runtimeAvailable: false });
    const { container } = renderCleanup(models);
    await waitFor(() => expect(models.status).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import model…' })).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't include the cleanup worker/)).not.toBeInTheDocument();
  });

  it('renders nothing while checking, on a status error, or in the browser', async () => {
    prod();
    const pending = { importModel: vi.fn(), status: vi.fn(() => new Promise<never>(() => {})) };
    const checking = renderCleanup(pending);
    expect(checking.container).toBeEmptyDOMElement();
    checking.unmount();
    const failing = renderCleanup({ importModel: vi.fn(), status: vi.fn().mockRejectedValue(new Error('denied')) });
    await act(async () => { await Promise.resolve(); });
    expect(failing.container).toBeEmptyDOMElement();
    failing.unmount();
    expect(renderCleanup(store(ready), false).container).toBeEmptyDOMElement();
  });

  it('lights up once the worker is available, without a model shown as import', async () => {
    prod();
    renderCleanup(store({ ...ready, available: false }));
    await waitFor(() => expect(block()).toBeInTheDocument());
    expect(screen.getByText(/Not installed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import model…' })).toBeEnabled();
  });

  it('keeps an already active cleanup visible so it can be turned off', async () => {
    prod();
    const user = userEvent.setup();
    renderCleanup(store({ ...ready, runtimeAvailable: false }), true, {
      cleanupEnabled: true, cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true,
    });
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    await user.click(toggle());
    expect(latest).toMatchObject({ cleanupEnabled: true, cleanupOptIn: false });
  });
});

describe('CleanupSettings in a production build, after the worker is known', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const missingModel = { ...ready, available: false };

  it('an import failure keeps the block and shows the error', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    const models = store(missingModel);
    vi.mocked(models.importModel).mockRejectedValue(new Error('picker exploded'));
    renderCleanup(models);
    const button = await screen.findByRole('button', { name: 'Import model…' });
    await user.click(button);
    await waitFor(() => expect(screen.getByText(/picker exploded/)).toBeInTheDocument());
    expect(screen.getByText('Local cleanup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import model…' })).toBe(button);
    expect(button).toHaveFocus();
  });

  it('Check again keeps the block and focus while it checks, and through an error', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    let fail!: (reason: Error) => void;
    let hold = false;
    const models: CleanupModelStore = {
      importModel: vi.fn(),
      status: vi.fn(() => hold
        ? new Promise<never>((_resolve, reject) => { fail = reject; })
        : Promise.resolve(missingModel)),
    };
    renderCleanup(models);
    const button = await screen.findByRole('button', { name: 'Check again' });
    await waitFor(() => expect(screen.getByText(/Not installed/)).toBeInTheDocument());
    hold = true;
    await user.click(button);
    expect(screen.getByText('Checking the cleanup model…')).toBeInTheDocument();
    expect(screen.getByText('Local cleanup')).toBeInTheDocument();
    expect(button).toHaveFocus();
    await act(async () => { fail(new Error('denied')); });
    expect(screen.getByText(/denied/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBe(button);
    expect(button).toHaveFocus();
  });

  it('a successful import keeps the block mounted', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    const models = store(missingModel);
    vi.mocked(models.importModel).mockResolvedValue(ready);
    renderCleanup(models);
    const button = await screen.findByRole('button', { name: 'Import model…' });
    await user.click(button);
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Import model…' })).toBe(button);
  });

  it('hides again once a check reports the worker gone', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    const { container } = renderCleanup(store(ready, { ...ready, runtimeAvailable: false }));
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('focus when turning cleanup off hides the block', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const activeStart = { cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true };
  function renderBetween(models: CleanupModelStore, after: boolean) {
    return renderWithApp(<div className="settings-rows">
      <Probe start={activeStart} />
      <div className="frow"><button type="button">Before</button></div>
      <Harness isNative modelStore={models} />
      {after && <div className="frow"><button type="button">After</button></div>}
    </div>);
  }

  it('moves focus to the next control, not the page body', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    renderBetween(store({ ...ready, runtimeAvailable: false }), true);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    await user.click(toggle());
    expect(screen.queryByText('Local cleanup')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('falls back to the previous control when nothing follows', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    renderBetween(store({ ...ready, runtimeAvailable: false }), false);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    await user.click(toggle());
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
  });

  it('leaves focus on the switch when the block stays (worker present)', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    renderBetween(store(ready), true);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    await user.click(toggle());
    expect(toggle()).toHaveFocus();
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });
});

describe('cleanup model status: one read per window', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('a stale status response cannot update the worker flag', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    const pending: ((status: CleanupModelStatus) => void)[] = [];
    let calls = 0;
    const models: CleanupModelStore = {
      importModel: vi.fn(),
      status: vi.fn(() => (++calls === 1
        ? Promise.resolve(ready)
        : new Promise<CleanupModelStatus>((resolve) => { pending.push(resolve); }))),
    };
    const { container } = renderCleanup(models);
    const check = await screen.findByRole('button', { name: 'Check again' });
    await user.click(check); // request 2 (stale)
    await user.click(check); // request 3 (latest)
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]({ ...ready, available: false }); });
    expect(screen.getByText(/Not installed/)).toBeInTheDocument();
    // The older request answers last, saying the worker is gone: ignored.
    await act(async () => { pending[0]({ ...ready, runtimeAvailable: false }); });
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByText(/Not installed/)).toBeInTheDocument();
  });

  it('Check again re-reads the status', async () => {
    const user = userEvent.setup();
    const models = store(ready);
    renderCleanup(models);
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(models.status).toHaveBeenCalledTimes(2));
  });
});

describe('focus handoff is armed only when the block will hide', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('turning off with a worker, then losing it, does not steal focus later', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    let answer!: (status: CleanupModelStatus) => void;
    let calls = 0;
    const models: CleanupModelStore = {
      importModel: vi.fn(),
      status: vi.fn(() => (++calls === 1
        ? Promise.resolve(ready)
        : new Promise<CleanupModelStatus>((resolve) => { answer = resolve; }))),
    };
    renderWithApp(<div className="settings-rows">
      <Probe start={{ cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true }} />
      <Harness isNative modelStore={models} />
      <div className="frow"><button type="button">After</button></div>
      <input aria-label="Elsewhere" />
    </div>);
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    await user.click(toggle());
    expect(toggle()).toHaveFocus();
    // Check again reports the worker gone; the user is typing elsewhere.
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    act(() => { screen.getByRole('textbox', { name: 'Elsewhere' }).focus(); });
    await act(async () => { answer({ ...ready, runtimeAvailable: false }); });
    expect(screen.queryByText('Local cleanup')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Elsewhere' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'After' })).not.toHaveFocus();
  });
});

describe('CleanupSettings in a dev build', () => {
  it('shows the block with the missing-worker note', async () => {
    expect(import.meta.env.DEV).toBe(true);
    renderCleanup(store({ ...ready, runtimeAvailable: false }));
    await waitFor(() => expect(screen.getByText(/doesn't include the cleanup worker yet/)).toBeInTheDocument());
    expect(screen.getByText('Local cleanup')).toBeInTheDocument();
    expect(toggle()).toBeDisabled();
  });
});
