// BUS-47: record the shortcut by pressing it.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';
import { captureShortcut, keyName } from '../../src/services/shortcut/shortcutCapture';
import { toPluginHotkey } from '../../src/services/shortcut/formatHotkey';
import { addAKey, HELP, inUseText, invalidText, resetText } from '../../src/features/settings/shortcutCopy';
import { comboLabel, spokenCombo } from '../../src/components/KeyCombo';

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
      .toMatchObject({ invalid: { feature: 'Spotlight', reason: 'reserved' }, kind: 'invalid' });
  });

  it('reserves ⌃⌘Space, ⌥⌘Space and ⌃⌘Q too', () => {
    const reserved = (code: string, key: string, mods: Partial<KeyboardEvent>) =>
      (captureShortcut(ev(code, key, mods)) as { invalid?: { reason: string } }).invalid?.reason;
    expect(reserved('Space', ' ', { ctrlKey: true, metaKey: true })).toBe('reserved');
    expect(reserved('Space', ' ', { altKey: true, metaKey: true })).toBe('reserved');
    expect(reserved('KeyQ', 'q', { ctrlKey: true, metaKey: true })).toBe('reserved');
  });
});

describe('recorder copy (designer final copy)', () => {
  it('says each refusal in words, with glyphs on macOS and words elsewhere', () => {
    const msg = (code: string, key: string, mods: Partial<KeyboardEvent> = {}, mac = true) => {
      const r = captureShortcut(ev(code, key, mods));
      return r.kind === 'invalid' ? invalidText(r.invalid, mac) : r.kind;
    };
    expect(msg('ArrowUp', 'ArrowUp', { ctrlKey: true }))
      .toBe('Up Arrow can\'t be used. Use a letter, number, Space, Return, Delete or Tab.');
    expect(msg('F5', 'F5', { ctrlKey: true })).toMatch(/^F5 can't be used/);
    expect(msg('NumpadEnter', 'Enter', { ctrlKey: true }))
      .toBe('Keypad Enter can\'t be used. Use Return instead.');
    expect(msg('KeyK', 'k')).toBe('Add ⌃, ⌥ or ⌘ to K.');
    expect(msg('KeyK', 'K', { shiftKey: true })).toBe('Shift alone isn\'t enough. Add ⌃, ⌥ or ⌘.');
    expect(msg('Space', ' ', { metaKey: true })).toBe('macOS uses ⌘Space for Spotlight. Choose another.');
    expect(msg('KeyK', 'k', {}, false)).toBe('Add Ctrl, Alt or Super to K.');
    expect(addAKey(true)).toBe('Add a key: hold ⌃, ⌥ or ⌘ and press a letter, number or Space.');
    expect(addAKey(false)).not.toMatch(/[⌃⌥⌘]/);
    expect(inUseText('Ctrl + Alt + B', 'Ctrl + Shift + Space', true))
      .toBe('⌃⌥B is in use by another app. Kept ⌃⇧Space.');
    expect(inUseText('Ctrl + Alt + B', 'Ctrl + Shift + Space', false))
      .toBe('Ctrl+Alt+B is in use by another app. Kept Ctrl+Shift+Space.');
    expect(resetText('Ctrl + Shift + Space', true)).toBe('Shortcut reset to ⌃⇧Space.');
    expect(HELP).toBe('Click, then press keys. Hold to dictate; double-tap to latch.');
  });

  it('shows Return and Delete on macOS and speaks what the label shows', () => {
    expect(comboLabel('Ctrl + Enter', true)).toBe('⌃Return');
    expect(comboLabel('Alt + Backspace', true)).toBe('⌥Delete');
    expect(comboLabel('Ctrl + Enter', false)).toBe('Ctrl+Enter');
    expect(spokenCombo('Ctrl + Meta + Space', true)).toBe('Control Command Space');
    expect(spokenCombo('Ctrl + Meta + Space', false)).toBe('Control Super Space');
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
    expect(field()).toHaveTextContent('Press keys…');
    expect(screen.getByRole('status')).toHaveTextContent('Press the new shortcut. Esc cancels.');
    // The status announces itself; describing the field by it would read it twice.
    expect(field().getAttribute('aria-describedby')).not.toMatch(/status/);
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
    expect(screen.getByRole('status')).toHaveTextContent('Canceled. Shortcut unchanged.');
  });

  it('an unsupported key shows an inline message and keeps recording', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(field());
    await user.keyboard('{Control>}{F5}{/Control}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/can't be used/);
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
    expect(screen.getByRole('status')).toHaveTextContent(/Add a key/);
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

  it('Shift+Tab cancels and lets focus move back', async () => {
    const onChange = vi.fn();
    render(<><button type="button">before</button><Harness onChange={onChange} /></>);
    const user = userEvent.setup();
    await user.click(field());
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'before' })).toHaveFocus();
    expect(field()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Canceled. Shortcut unchanged.');
    expect(onChange).not.toHaveBeenCalled();
    expect(captureShortcut(ev('Tab', 'Tab', { shiftKey: true })))
      .toEqual({ kind: 'cancel', reason: 'tab' });
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

describe('BUS-47 review follow-ups', () => {
  it('rejects NumpadEnter instead of saving it as Enter', () => {
    expect(keyName('NumpadEnter')).toBeNull();
    expect(captureShortcut(ev('NumpadEnter', 'Enter', { ctrlKey: true })).kind).toBe('invalid');
  });

  it('matches a recorded chord by physical code on non-US layouts', async () => {
    const { matchesShortcut } = await import('../../src/services/shortcut/formatHotkey');
    const combo = (captureShortcut(ev('KeyK', 'å', { altKey: true })) as { combo: string }).combo;
    expect(matchesShortcut(ev('KeyK', 'å', { altKey: true }), combo)).toBe(true);
    expect(matchesShortcut(ev('KeyL', 'k', { altKey: true }), combo)).toBe(false);
  });
});
