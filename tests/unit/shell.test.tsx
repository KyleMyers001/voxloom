import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { Switch } from '../../src/components/Switch';
import { screenForAltDigit } from '../../src/app/shell/screens';
import { Sidebar } from '../../src/app/shell/Sidebar';
import { TitleBar } from '../../src/app/shell/TitleBar';
import { Home } from '../../src/features/home/Home';
import { isTauriEnv } from '../../src/services/capture/captureService';
import type { UseDogfoodCaptureResult } from '../../src/services/stt/useDogfoodCapture';
import { renderWithApp } from './testUtils';

const dogfood = (over: Partial<UseDogfoodCaptureResult> = {}): UseDogfoodCaptureResult => ({
  cancel: vi.fn(), captureState: { kind: 'idle' }, hudResult: null, intendedTarget: null, message: null,
  origin: null, phase: 'idle', start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined), transcript: null, ...over,
});

async function renderShell() {
  const user = userEvent.setup();
  renderWithApp(<App />);
  await user.click(screen.getByRole('button', { name: 'Skip' }));
  return user;
}

const current = () => within(screen.getByRole('navigation', { name: 'Voxloom screens' }))
  .getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page')?.getAttribute('aria-label');

afterEach(() => vi.mocked(isTauriEnv).mockReturnValue(false));

describe('App shell (UI PR 3)', () => {
  it('has three sidebar screens, the brand status line and the short hint', async () => {
    await renderShell();
    const nav = screen.getByRole('navigation', { name: 'Voxloom screens' });
    expect(within(nav).getAllByRole('button').map((b) => b.getAttribute('aria-label')))
      .toEqual(['Home', 'History', 'Dictionary']);
    const status = document.querySelector('.brand__status')!;
    expect(status).toHaveTextContent('Ready · ⌃⇧Space');
    expect(status).not.toHaveAttribute('aria-label');
    // <=780px: the shortcut moves to its own line as key caps (BUS-41 PR 2).
    expect([...document.querySelectorAll('.brand__caps .kbd')].map((k) => k.textContent)).toEqual(['⌃', '⇧', 'Space']);
    expect(screen.getByText(/Hold the shortcut in any app to dictate/)).toBeInTheDocument();
    expect(screen.queryByText(/Global hold\/latch snapshots/)).not.toBeInTheDocument();
  });

  it('⌥1–3 navigate, including the macOS Option-digit key values', async () => {
    const user = await renderShell();
    await user.keyboard('{Alt>}3{/Alt}');
    expect(current()).toBe('Dictionary');
    fireEvent.keyDown(document, { altKey: true, code: 'Digit2', key: '™' });
    expect(current()).toBe('History');
    fireEvent.keyDown(document, { altKey: true, code: 'Digit1', key: '¡' });
    expect(current()).toBe('Home');
  });

  it('ignores ⌥-digits while typing or composing, and with other modifiers', async () => {
    await renderShell();
    const input = document.createElement('input');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    document.body.append(input, editable, textarea, select);
    const alt2 = { altKey: true, code: 'Digit2', key: '™' };
    fireEvent.keyDown(input, alt2);
    fireEvent.keyDown(textarea, alt2);
    fireEvent.keyDown(select, alt2);
    fireEvent.keyDown(editable, alt2);
    fireEvent.keyDown(document, { ...alt2, isComposing: true });
    fireEvent.keyDown(document, { ...alt2, metaKey: true });
    fireEvent.keyDown(document, { ...alt2, ctrlKey: true });
    fireEvent.keyDown(document, { ...alt2, shiftKey: true });
    expect(current()).toBe('Home');
    input.remove();
    editable.remove();
    textarea.remove();
    select.remove();
  });

  it('⌥-digits still navigate from non-text inputs (radio, checkbox)', async () => {
    await renderShell();
    const radio = document.createElement('input');
    radio.type = 'radio';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.append(radio, checkbox);
    fireEvent.keyDown(radio, { altKey: true, code: 'Digit2', key: '™' });
    expect(current()).toBe('History');
    fireEvent.keyDown(checkbox, { altKey: true, code: 'Digit3', key: '£' });
    expect(current()).toBe('Dictionary');
    radio.remove();
    checkbox.remove();
  });

  it('⌥2 still navigates while a SegmentedControl radio or a Switch has focus', async () => {
    const user = await renderShell();
    const casual = screen.getByRole('radio', { name: /^Casual$/ });
    casual.focus();
    await user.keyboard('{Alt>}2{/Alt}');
    expect(current()).toBe('History');
    render(<Switch checked={false} label="Probe switch" onChange={vi.fn()} />);
    const probe = screen.getByRole('switch', { name: 'Probe switch' });
    probe.focus();
    fireEvent.keyDown(probe, { altKey: true, code: 'Digit1', key: '¡' });
    expect(current()).toBe('Home');
  });

  it('prevents the default action only when ⌥-digit navigates', async () => {
    await renderShell();
    expect(fireEvent.keyDown(document, { altKey: true, code: 'Digit2', key: '™' })).toBe(false);
    expect(current()).toBe('History');
    expect(fireEvent.keyDown(document, { altKey: true, code: 'Digit7', key: '¶' })).toBe(true);
  });

  it('opens Settings from the title bar, ⌥4 and ⌘,', async () => {
    const user = await renderShell();
    const settings = screen.getByRole('button', { name: 'Settings' });
    await user.click(settings);
    expect(settings).toHaveAttribute('aria-current', 'page');
    expect(current()).toBeUndefined();
    await user.keyboard('{Alt>}1{/Alt}');
    await user.keyboard('{Alt>}4{/Alt}');
    expect(settings).toHaveAttribute('aria-current', 'page');
    await user.keyboard('{Alt>}1{/Alt}');
    fireEvent.keyDown(document, { key: ',', metaKey: true });
    expect(settings).toHaveAttribute('aria-current', 'page');
  });

  it('maps Alt digits to screens', () => {
    expect(['1', '2', '3', '4', '5'].map(screenForAltDigit))
      .toEqual(['home', 'history', 'dictionary', 'settings', null]);
  });
});

describe('Home (UI PR 3)', () => {
  it('shows a status badge on each recent row', () => {
    renderWithApp(<Home dogfood={dogfood()} onToast={vi.fn()} />);
    const rows = document.querySelectorAll('.home .recent-row');
    expect(rows).toHaveLength(5);
    rows.forEach((row) => expect(row.querySelector('.badge')).not.toBeNull());
  });

  it('hides the browser-only Start capture note in the native app', () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    renderWithApp(<Home dogfood={dogfood()} onToast={vi.fn()} />);
    expect(screen.queryByText(/Native capture requires the Tauri shell/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start capture' })).toBeEnabled();
    const caption = screen.getByText('Style preference · cleanup not available yet');
    // Caption precedes the segmented control.
    expect(caption.compareDocumentPosition(screen.getByRole('radiogroup', { name: 'Current writing style' })))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows Stop/Cancel while recording and Transcribing… while busy', () => {
    const { unmount } = renderWithApp(<Home dogfood={dogfood({ phase: 'recording' })} onToast={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    unmount();
    renderWithApp(<Home dogfood={dogfood({ phase: 'transcribing' })} onToast={vi.fn()} />);
    expect(screen.getByText('Transcribing…')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: 'Start capture' })).not.toBeInTheDocument();
  });
});

describe('Title bar (designer: standard macOS title bar)', () => {
  it('draws the app name only in the browser preview, never a fake inset', async () => {
    const { unmount, container } = renderWithApp(<App />);
    expect(container.querySelector('.titlebar__title')).toHaveTextContent('Voxloom');
    unmount();
    vi.mocked(isTauriEnv).mockReturnValue(true);
    const native = renderWithApp(<App />);
    expect(native.container.querySelector('.titlebar__title')).toBeNull();
  });
});

describe('off-Mac shell labels (QA #45)', () => {
  it('title bar says Ctrl+, and the sidebar says Alt+1–3 and Ctrl+Shift+Space', () => {
    const spy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    try {
      render(<TitleBar onHelp={() => {}} onSettings={() => {}} settingsOpen={false} />);
      expect(screen.getByRole('button', { name: 'Settings' })).toHaveTextContent('Settings… Ctrl+,');
      renderWithApp(
        <Sidebar onNavigate={() => {}} onReset={() => {}} onScenario={() => {}} screen="home" shortcut="Control+Shift+Space" status="Ready" />,
      );
      expect(document.querySelector('.brand__status')).toHaveTextContent('Ready · Ctrl+Shift+Space');
      expect(document.body.textContent).toContain('Alt+1');
      expect(document.body.textContent).not.toMatch(/[⌥⌘⌃⇧]/);
    } finally {
      spy.mockRestore();
    }
  });
});
