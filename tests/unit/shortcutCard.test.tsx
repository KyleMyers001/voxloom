// BUS-219: guided setup step 2 "Your shortcut" card (Option A, SPEC.md).
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';
import { resetRecorderStore } from '../../src/features/settings/recorderStore';
import {
  cardInUseText, cardNoneActiveText, holdHint, resetLinkText, savedText, shortcutName,
} from '../../src/features/settings/shortcutCopy';

const DEFAULT = 'Ctrl + Shift + Space';
const COMBO_HINT = 'Hold the keys while you talk. Let go when you’re done.';
const KEY_HINT = 'Hold the key while you talk. Let go when you’re done.';
const RECORDING_HELP = 'Press them together, like ⌃ ⌥ Space, or press one key, like Right Option. Changed your mind? Press Esc or choose Cancel to keep your current shortcut.';

function Card({ initial = DEFAULT, onChange = () => {} }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return <ShortcutRecorder defaultValue={DEFAULT} id="onboarding-shortcut" onChange={(next) => { setValue(next); onChange(next); }} value={value} variant="card" />;
}
const change = () => screen.getByRole('button', { name: 'Change shortcut' });
const recorder = () => screen.getByRole('button', { name: 'Dictation shortcut, recording' });
const message = () => screen.getByRole('status');
const help = () => document.getElementById('onboarding-shortcut-help')!;
/** The help/hint is plain text: it must not sit in the live region (it would be read on every change). */
const expectHelpNotLive = () => expect(help().closest('[aria-live], [role="status"]')).toBeNull();
const card = () => screen.getByRole('group');

describe('setup shortcut copy', () => {
  it('says "keys" for a combo and "key" for a lone key', () => {
    expect(holdHint(DEFAULT)).toBe(COMBO_HINT);
    expect(holdHint('Ctrl + Alt + K')).toBe(COMBO_HINT);
    expect(holdHint('AltRight')).toBe(KEY_HINT);
    expect(holdHint('MetaRight')).toBe(KEY_HINT);
    expect(holdHint('F13')).toBe(KEY_HINT);
  });
  it('names a lone key in words with its glyph, and a combo by its caps', () => {
    expect(shortcutName('AltRight', true)).toBe('Right Option (⌥)');
    expect(shortcutName(DEFAULT, true)).toBe('⌃⇧Space');
    expect(shortcutName('F15', true)).toBe('F15');
  });
  it('matches the spec strings exactly', () => {
    expect(savedText('AltRight', true)).toBe('Saved. On the next step, hold Right Option (⌥) to try it.');
    expect(savedText(DEFAULT, true)).toBe('Saved. On the next step, hold ⌃⇧Space to try it.');
    expect(savedText('ShiftRight', true)).toBe('Saved. On the next step, hold Right Shift (⇧) to try it. Right ⇧ is also used for typing, so it may start dictation by accident.');
    expect(cardInUseText('Alt + Meta + D', DEFAULT, true)).toBe('Another app already uses ⌥⌘D, so we kept your current shortcut, ⌃⇧Space. Try different keys.');
    expect(cardNoneActiveText('Alt + Meta + D', true, true)).toBe('⌥⌘D didn’t work, and no shortcut is set right now. Try different keys, or go back to the default.');
    // No link to promise when the keys shown already are the default.
    expect(cardNoneActiveText(DEFAULT, false, true)).toBe('⌃⇧Space didn’t work, and no shortcut is set right now. Try different keys.');
    expect(resetLinkText(DEFAULT, true)).toBe('Go back to the default (⌃ ⇧ Space)');
  });
});

describe('setup shortcut card', () => {
  beforeEach(() => resetRecorderStore());

  it('shows the default once with a Default pill, Change shortcut and the combo hint', () => {
    render(<Card />);
    expect(card()).toHaveAccessibleName('Your shortcut Default');
    expect(card()).toHaveTextContent('⌃⇧Space');
    expect(screen.getAllByText('Control Shift Space')).toHaveLength(1);
    expect(help()).toHaveTextContent(COMBO_HINT);
    expect(help()).toBeVisible();
    expectHelpNotLive();
    expect(message()).toBeEmptyDOMElement();
    expect(change()).toHaveAccessibleDescription(COMBO_HINT);
    expect(screen.queryByRole('button', { name: /Go back to the default/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument();
  });

  it('a custom lone key shows one cap, its name, the "key" hint and the link back', async () => {
    render(<Card initial="AltRight" />);
    expect(card()).toHaveAccessibleName('Your shortcut');
    expect(card().querySelectorAll('kbd')).toHaveLength(1);
    expect(card().querySelector('kbd')).toHaveTextContent(/^⌥$/);
    expect(card()).toHaveTextContent('Right Option');
    expect(help()).toHaveTextContent(KEY_HINT);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Go back to the default (⌃ ⇧ Space)' }));
    expect(card()).toHaveAccessibleName('Your shortcut Default');
    expect(message()).toHaveTextContent('✓Saved. On the next step, hold ⌃⇧Space to try it.');
  });

  it('Change turns the card into the focused recorder; Esc keeps the shortcut and returns focus', async () => {
    const onChange = vi.fn();
    render(<Card onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(change());
    expect(recorder()).toHaveFocus();
    expect(recorder()).toHaveAttribute('aria-pressed', 'true');
    expect(recorder()).toHaveTextContent('Waiting for your keys…');
    expect(card()).toHaveAccessibleName('Now press the keys you want to use');
    expect(help()).toHaveTextContent(RECORDING_HELP);
    expectHelpNotLive();
    expect(recorder()).toHaveAccessibleDescription(RECORDING_HELP);
    expect(message()).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(change()).toHaveFocus();
    expect(help()).toHaveTextContent(COMBO_HINT);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Cancel (a click away) ends recording through the same cancel', async () => {
    const onChange = vi.fn();
    render(<Card onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(change());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Dictation shortcut, recording' })).not.toBeInTheDocument();
    expect(change()).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clicking Cancel without a blur first (WebKit) ends recording and returns focus to Change', async () => {
    const onChange = vi.fn();
    render(<Card onChange={onChange} />);
    await userEvent.setup().click(change());
    expect(recorder()).toHaveFocus();
    // fireEvent.click moves no focus, so the recorder never blurs.
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(screen.queryByRole('button', { name: 'Dictation shortcut, recording' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(change()).toHaveFocus();
    expect(help()).toHaveTextContent(COMBO_HINT);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('previews held modifiers, shows invalid keys in the help slot, and saves a lone key', async () => {
    const onChange = vi.fn();
    render(<Card onChange={onChange} />);
    await userEvent.setup().click(change());
    act(() => { fireEvent.keyDown(window, { code: 'KeyK', key: 'k' }); });
    expect(message()).toHaveTextContent('Add ⌃, ⌥, ⌘ or ⇧ to K.');
    expect(message()).toHaveAttribute('data-tone', 'error');
    expect(recorder()).toHaveAttribute('aria-invalid', 'true');
    // The error is announced by the live region; the recorder is described by the help only, so it isn't read twice.
    expect(help()).not.toBeVisible();
    expect(recorder()).toHaveAccessibleDescription(RECORDING_HELP);
    act(() => { fireEvent.keyDown(window, { code: 'AltRight', key: 'Alt', altKey: true }); });
    expect(recorder()).toHaveTextContent('⌥ (right) …');
    act(() => { fireEvent.keyUp(window, { code: 'AltRight', key: 'Alt' }); });
    expect(onChange).toHaveBeenLastCalledWith('AltRight');
    expect(message()).toHaveTextContent('✓Saved. On the next step, hold Right Option (⌥) to try it.');
    expect(message()).not.toHaveTextContent('Shortcut set to');
    expect(screen.getByRole('button', { name: 'Go back to the default (⌃ ⇧ Space)' })).toBeInTheDocument();
  });

  it('a saved combo says "keys" again once the status clears', async () => {
    render(<Card initial="AltRight" />);
    const user = userEvent.setup();
    await user.click(change());
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    expect(message()).toHaveTextContent('✓Saved. On the next step, hold ⌃⌥K to try it.');
    await user.click(change());
    await user.keyboard('{Escape}');
    expect(help()).toHaveTextContent(COMBO_HINT);
  });
});
