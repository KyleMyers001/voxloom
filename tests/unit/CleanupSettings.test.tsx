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
  return { status };
}

let latest: Settings = initialSettings;
function Probe({ start }: { start?: Partial<Settings> }) {
  const { dispatch, state } = useApp();
  useEffect(() => {
    if (start) dispatch({ now: Date.now(), onboardingComplete: true, settings: { ...initialSettings, ...start }, type: 'hydrate-settings' });
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

  it.each([
    ['no status', undefined],
    ['a non-string id', { ...ready, id: 42 }],
    ['a missing id', { available: true, runtimeAvailable: true, sha256: CLEANUP_MODEL_SHA256 }],
  ])('rejects a malformed native status (%s)', async (_label, status) => {
    renderCleanup({ status: vi.fn().mockResolvedValue(status) });
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
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn't include the cleanup worker/)).not.toBeInTheDocument();
  });

  it('renders nothing while checking, on a status error, or in the browser', async () => {
    prod();
    const pending = { status: vi.fn(() => new Promise<never>(() => {})) };
    const checking = renderCleanup(pending);
    expect(checking.container).toBeEmptyDOMElement();
    checking.unmount();
    const failing = renderCleanup({ status: vi.fn().mockRejectedValue(new Error('denied')) });
    await act(async () => { await Promise.resolve(); });
    expect(failing.container).toBeEmptyDOMElement();
    failing.unmount();
    expect(renderCleanup(store(ready), false).container).toBeEmptyDOMElement();
  });

  it('lights up once the worker is available, with no model installed', async () => {
    prod();
    renderCleanup(store({ ...ready, available: false }));
    await waitFor(() => expect(block()).toBeInTheDocument());
    expect(screen.getByText(/Not installed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
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

  // BUS-101 item 2: when the block is shown (active), a first-read error keeps
  // the error note and Check again. Production + inactive still hides (above).
  it('active cleanup: a first status error still shows the note and Check again', async () => {
    prod();
    renderCleanup(
      { status: vi.fn().mockRejectedValue(new Error('denied')) },
      true,
      { cleanupModelId: CLEANUP_MODEL_ID, cleanupOptIn: true },
    );
    await waitFor(() => expect(screen.getByText(/Couldn't check the cleanup model: denied/)).toBeInTheDocument());
    expect(screen.getByText('Local cleanup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });
});

describe('CleanupSettings in a production build, after the worker is known', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const missingModel = { ...ready, available: false };

  it('Check again keeps the block and focus while it checks, and through an error', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    let fail!: (reason: Error) => void;
    let hold = false;
    const models: CleanupModelStore = {
      
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

  it('two Check again clicks during a check produce one status call (BUS-106)', async () => {
    vi.stubEnv('DEV', false);
    const user = userEvent.setup();
    let finish!: (status: CleanupModelStatus) => void;
    let calls = 0;
    const models: CleanupModelStore = {
      
      status: vi.fn(() => (++calls === 1
        ? Promise.resolve(ready)
        : new Promise<CleanupModelStatus>((resolve) => { finish = resolve; }))),
    };
    renderCleanup(models);
    const check = await screen.findByRole('button', { name: 'Check again' });
    await waitFor(() => expect(screen.getByText('Qwen3 0.6B is installed.')).toBeInTheDocument());
    await user.click(check);
    expect(check).toHaveAttribute('aria-disabled', 'true');
    await user.click(check);
    await user.click(check);
    expect(models.status).toHaveBeenCalledTimes(2); // boot + one Check again
    await act(async () => { finish({ ...ready, available: false }); });
    await waitFor(() => expect(screen.getByText(/Not installed/)).toBeInTheDocument());
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
