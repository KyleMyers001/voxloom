// BUS-47: record the shortcut by pressing it.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';
import { captureShortcut, keyName } from '../../src/services/shortcut/shortcutCapture';
import { toPluginHotkey } from '../../src/services/shortcut/formatHotkey';

const DEFAULT = 'Ctrl + Shift + Space';
const ev = (code: string, key: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({
  altKey: false, code, ctrlKey: false, key, metaKey: false, shiftKey: false, ...mods,
});

function Harness({ onChange = vi.fn() }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState(DEFAULT);
  return (
    <ShortcutRecorder
      defaultValue={DEFAULT}
      onChange={(next) => { setValue(next); onChange(next); }}
      value={value}
    />
  );
}

const field = () => screen.getByRole('button', { name: /^Dictation shortcut/ });

describe('captureShortcut', () => {
  it('captures modifier + key by physical code in stored order', () => {
    expect(captureShortcut(ev('KeyK', 'å', { altKey: true, metaKey: true })))
      .toEqual({ combo: 'Alt + Meta + K', kind: 'captured' });
    expect(captureShortcut(ev('Space', ' ', { altKey: true })))
      .toEqual({ combo: 'Alt + Space', kind: 'captured' });
  });

  it('only produces keys the native parser accepts', () => {
    expect(toPluginHotkey('Alt + Meta + K')).toBe('Alt+Command+K');
    expect(keyName('F5')).toBeNull();
    expect(keyName('ArrowLeft')).toBeNull();
    expect(keyName('Digit7')).toBe('7');
  });

  it('rejects bare keys, Shift-only, Esc, lone modifiers and reserved combos', () => {
    expect(captureShortcut(ev('KeyK', 'k')).kind).toBe('invalid');
    expect(captureShortcut(ev('KeyK', 'K', { shiftKey: true })).kind).toBe('invalid');
    expect(captureShortcut(ev('Escape', 'Escape', { altKey: true })))
      .toEqual({ kind: 'cancel', reason: 'escape' });
    expect(captureShortcut(ev('AltRight', 'Alt', { altKey: true })))
      .toEqual({ kind: 'modifier-only', preview: 'Alt' });
    expect(captureShortcut(ev('Space', ' ', { metaKey: true })))
      .toMatchObject({ kind: 'invalid', message: expect.stringMatching(/Spotlight/) });
  });
});

describe('ShortcutRecorder', () => {
  it('does not record on focus alone', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.tab();
    expect(field()).toHaveFocus();
    await user.keyboard('{Control>}k{/Control}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('captures a pressed chord, saves it and announces it', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    expect(field()).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Alt>}{Meta>}j{/Meta}{/Alt}');
    expect(onChange).toHaveBeenCalledWith('Alt + Meta + J');
    expect(field()).toHaveAccessibleName('Dictation shortcut, Option Command J');
    expect(screen.getByRole('status')).toHaveTextContent(/Shortcut set to/);
  });

  it('Esc cancels and keeps the previous shortcut', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Escape}');
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute('aria-pressed', 'false');
    expect(field()).toHaveAccessibleName('Dictation shortcut, Control Shift Space');
    expect(screen.getByRole('status')).toHaveTextContent(/canceled/);
  });

  it('an unsupported key shows an inline message and keeps recording', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{F5}{/Control}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/can't be used/);
    expect(field()).toHaveAttribute('aria-pressed', 'true');
  });

  it('a lone modifier shows a preview, then "Add a key" and saves nothing', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Alt>}');
    expect(field()).toHaveTextContent('…');
    await user.keyboard('{/Alt}');
    expect(screen.getByRole('alert')).toHaveTextContent(/Add a key/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Tab and blur cancel without trapping focus', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.tab();
    expect(field()).not.toHaveFocus();
    expect(field()).toHaveAttribute('aria-pressed', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Reset to default restores the default combo', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Alt>}j{/Alt}');
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
  });
});
