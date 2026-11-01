// BUS-46 slice 1: the recorder captures a lone modifier on a clean keyup.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';

const DEFAULT = 'Ctrl + Shift + Space';
type Mods = Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>>;

function Harness({ onChange }: { onChange: (v: string) => void }) {
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
const status = () => screen.getByRole('status');
const down = (code: string, key: string, mods: Mods) =>
  act(() => { fireEvent.keyDown(window, { code, key, ...mods }); });
const up = (code: string, key: string, mods: Mods = {}) =>
  act(() => { fireEvent.keyUp(window, { code, key, ...mods }); });

async function record(onChange = vi.fn()) {
  render(<Harness onChange={onChange} />);
  await userEvent.setup().click(field());
  return onChange;
}

describe('lone modifier capture', () => {
  it('previews a right-hand modifier while held, saves it on a clean keyup', async () => {
    const onChange = await record();
    down('AltRight', 'Alt', { altKey: true });
    expect(field()).toHaveTextContent('(right)');
    expect(onChange).not.toHaveBeenCalled();
    up('AltRight', 'Alt');
    expect(onChange).toHaveBeenCalledWith('AltRight');
    expect(field()).toHaveAccessibleName('Dictation shortcut, Right Option');
  });

  it.each([
    ['ControlRight', 'Control', { ctrlKey: true }],
    ['MetaRight', 'Meta', { metaKey: true }],
    ['ShiftRight', 'Shift', { shiftKey: true }],
  ] as const)('captures %s', async (code, key, mods) => {
    const onChange = await record();
    down(code, key, mods);
    up(code, key);
    expect(onChange).toHaveBeenCalledWith(code);
  });

  it('warns after saving Right Shift', async () => {
    await record();
    down('ShiftRight', 'Shift', { shiftKey: true });
    up('ShiftRight', 'Shift');
    expect(status()).toHaveTextContent(/also used for typing/);
  });

  it('does not save when another key was pressed in between (Option+E)', async () => {
    const onChange = await record();
    down('AltRight', 'Alt', { altKey: true });
    down('KeyE', 'e', { altKey: true });
    up('KeyE', 'e', { altKey: true });
    up('AltRight', 'Alt');
    // Only the chord is saved, never the modifier on its own.
    expect(onChange.mock.calls).toEqual([['Alt + E']]);
  });

  it('does not save when a second modifier joins (Option+Shift)', async () => {
    const onChange = await record();
    down('AltRight', 'Alt', { altKey: true });
    down('ShiftLeft', 'Shift', { altKey: true, shiftKey: true });
    up('AltRight', 'Alt', { shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
    up('ShiftLeft', 'Shift');
    expect(onChange).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent(/Add a key/);
  });

  it('rejects a left-hand modifier and suggests the right-hand one', async () => {
    const onChange = await record();
    down('AltLeft', 'Alt', { altKey: true });
    up('AltLeft', 'Alt');
    expect(onChange).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent(/Left .* can't be used on its own\. Use .*\(right\) instead/);
    expect(field()).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores a keyup for a modifier that was already held when recording began', async () => {
    const onChange = await record();
    up('AltRight', 'Alt');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('captures F13 alone and rejects F13 with a modifier', async () => {
    const onChange = await record();
    down('F13', 'F13', { altKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent(/F13 works on its own/);
    down('F13', 'F13', {});
    expect(onChange).toHaveBeenCalledWith('F13');
  });

  it('rejects a letter alone, and Esc and Tab keep cancelling', async () => {
    const onChange = await record();
    down('KeyK', 'k', {});
    expect(status()).toHaveTextContent('Add ⌃, ⌥, ⌘ or ⇧ to K.');
    down('Escape', 'Escape', {});
    expect(status()).toHaveTextContent('Canceled. Shortcut unchanged.');
    expect(onChange).not.toHaveBeenCalled();
  });
});
