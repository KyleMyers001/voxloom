/// UI PR 6b: native Settings window wiring (open/focus, settings:changed sync, onboarding:open).
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { AppProvider, useApp } from '../../src/app/AppContext';
import { isTauriEnv } from '../../src/services/capture/captureService';
import {
  createMemorySettingsIo, createSettingsStore, defaultSettingsFile, serializeSettingsFile,
} from '../../src/services/settings';
import { SettingsWindowApp } from '../../src/settings/SettingsWindowApp';

const bridge = vi.hoisted(() => ({
  onboarding: null as null | (() => void),
  open: vi.fn().mockResolvedValue(undefined),
  request: vi.fn().mockResolvedValue(undefined),
  settings: null as null | ((p: { contents: string }) => void),
}));

vi.mock('../../src/services/settingsWindow', async (importActual) => ({
  ...(await importActual<typeof import('../../src/services/settingsWindow')>()),
  listenOnboardingOpen: (h: () => void) => { bridge.onboarding = h; return Promise.resolve(() => {}); },
  listenSettingsChanged: (h: (p: { contents: string }) => void) => {
    bridge.settings = h;
    return Promise.resolve(() => { bridge.settings = null; });
  },
  openSettingsWindow: bridge.open,
  requestOnboarding: bridge.request,
}));

vi.mock('../../src/services/capture/captureService', async (importActual) => ({
  ...(await importActual<typeof import('../../src/services/capture/captureService')>()),
  isTauriEnv: vi.fn().mockReturnValue(false),
}));

function durable(initial?: string) {
  const io = createMemorySettingsIo(initial);
  return { io, persistence: { enabled: true, store: createSettingsStore(io) } };
}

function fileWith(style: 'formal' | 'casual' | 'very-casual', complete = true) {
  const file = defaultSettingsFile();
  return serializeSettingsFile({ ...file.settings, style }, complete);
}

function StyleProbe() {
  const { state } = useApp();
  return <output aria-label="style">{state.settings.style}</output>;
}

beforeEach(() => {
  bridge.open.mockClear();
  bridge.request.mockClear();
});
afterEach(() => vi.mocked(isTauriEnv).mockReturnValue(false));

describe('settings:changed sync', () => {
  it('re-hydrates from another window without writing the file back', async () => {
    const { io, persistence } = durable(fileWith('casual'));
    render(<AppProvider settingsPersistence={persistence}><StyleProbe /></AppProvider>);
    await waitFor(() => expect(screen.getByLabelText('style')).toHaveTextContent('casual'));
    await waitFor(() => expect(bridge.settings).not.toBeNull());
    const saved = fileWith('very-casual');
    await io.write(saved);
    const writes = vi.spyOn(io, 'write');
    act(() => bridge.settings?.({ contents: saved }));
    expect(screen.getByLabelText('style')).toHaveTextContent('very-casual');
    await new Promise((r) => setTimeout(r, 20));
    expect(writes.mock.calls).toEqual([]);
  });

  it('ignores an unparseable payload', async () => {
    const { persistence } = durable(fileWith('casual'));
    render(<AppProvider settingsPersistence={persistence}><StyleProbe /></AppProvider>);
    await waitFor(() => expect(screen.getByLabelText('style')).toHaveTextContent('casual'));
    act(() => bridge.settings?.({ contents: '{nope' }));
    expect(screen.getByLabelText('style')).toHaveTextContent('casual');
  });
});

describe('main window in the native app', () => {
  it('opens the Settings window from the title bar, ⌥4 and ⌘, instead of rendering in-page', async () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    const user = userEvent.setup();
    render(<AppProvider clock={() => 1_800_000_000_000}><App /></AppProvider>);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.keyboard('{Alt>}4{/Alt}');
    await user.keyboard('{Meta>},{/Meta}');
    expect(bridge.open).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('tablist', { name: 'Settings sections' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('Settings');
  });

  it('opens onboarding when the Settings window asks (onboarding:open)', async () => {
    const user = userEvent.setup();
    render(<AppProvider clock={() => 1_800_000_000_000}><App /></AppProvider>);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.queryByText('Step 1 of 3')).toBeNull();
    act(() => bridge.onboarding?.());
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
  });
});

describe('Settings window root', () => {
  it('renders the tabbed Settings and routes "Set up shortcuts" to main', async () => {
    const user = userEvent.setup();
    render(<AppProvider><SettingsWindowApp /></AppProvider>);
    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up shortcuts' }));
    expect(bridge.request).toHaveBeenCalledOnce();
  });
});
