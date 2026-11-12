/// BUS-216: guided setup is the window itself, not a modal over Home.
import { isTauri } from '@tauri-apps/api/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { SetupWindow } from '../../src/features/onboarding/SetupWindow';
import { renderWithApp } from './testUtils';

const setTitle = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTitle }) }));

const progressKey = 'voxloom.guided-setup.v1';
const shell = () => document.querySelector<HTMLElement>('#app-shell');

function expectFullWindowSetup() {
  expect(screen.getByRole('main', { name: 'Set up Voxloom' })).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Close Set up Voxloom' })).not.toBeInTheDocument();
  expect(document.querySelector('.overlay')).toBeNull();
  // The shell (title bar, sidebar, Home) is neither shown nor reachable.
  expect(shell()).not.toBeVisible();
  for (const name of ['Home', 'History', 'Dictionary', 'Settings']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  expect(document.title).toBe('Set up Voxloom');
}

describe('full-window guided setup', () => {
  afterEach(() => { localStorage.clear(); vi.mocked(isTauri).mockReturnValue(false); setTitle.mockClear(); });

  it('first run fills the window, and Set up later returns to the app with the banner', async () => {
    const user = userEvent.setup();
    document.title = 'Voxloom';
    renderWithApp(<App />);
    expectFullWindowSetup();
    await user.click(screen.getByRole('button', { name: 'Set up later' }));
    expect(screen.queryByRole('main', { name: 'Set up Voxloom' })).not.toBeInTheDocument();
    expect(shell()).toBeVisible();
    expect(screen.getByText(/Setup is incomplete/)).toBeVisible();
    expect(document.title).toBe('Voxloom');
  });

  it('Resume setup is full-window too and keeps a Set up later on later steps', async () => {
    localStorage.setItem(progressKey, JSON.stringify({ version: 1, step: 3, holdDone: true, tapDone: false, mode: 'tap', modelId: 'whisper-base.en', shortcut: 'Ctrl + Shift + Space' }));
    const user = userEvent.setup();
    renderWithApp(<App />);
    await user.click(screen.getByRole('button', { name: 'Set up later' }));
    await user.click(screen.getByRole('button', { name: 'Resume setup' }));
    expectFullWindowSetup();
    expect(screen.getByRole('heading', { name: 'Now, go hands-free.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up later' }));
    expect(shell()).toBeVisible();
    expect(screen.getByText(/Setup is incomplete/)).toBeVisible();
  });

  it('Skip setup still completes without practice and shows the normal app', async () => {
    localStorage.setItem(progressKey, JSON.stringify({ version: 1, step: 2 }));
    const user = userEvent.setup();
    renderWithApp(<App />);
    expectFullWindowSetup();
    await user.click(screen.getByRole('button', { name: 'Skip setup' }));
    expect(shell()).toBeVisible();
    expect(screen.queryByText(/Setup is incomplete/)).not.toBeInTheDocument();
    expect(document.querySelector('.brand__status')).toHaveTextContent('Ready');
    expect(localStorage.getItem(progressKey)).toBeNull();
  });

  it('reopening setup from Settings uses the full-window layout', async () => {
    const user = userEvent.setup();
    renderWithApp(<App />);
    await user.click(screen.getByRole('button', { name: 'Skip setup' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Set up shortcuts' }));
    expectFullWindowSetup();
    expect(screen.getByText(/Less typing/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(shell()).toBeVisible();
    expect(screen.getByRole('button', { name: 'Set up shortcuts' })).toHaveFocus();
  });

  it('names the native window "Set up Voxloom" while setup fills it, then restores it', () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const view = render(<SetupWindow onEscape={vi.fn()}><h2>Setup</h2></SetupWindow>);
    expect(setTitle).toHaveBeenLastCalledWith('Set up Voxloom');
    view.unmount();
    expect(setTitle).toHaveBeenLastCalledWith('Voxloom');
  });
});
