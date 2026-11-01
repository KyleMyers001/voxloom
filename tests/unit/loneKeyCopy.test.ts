// BUS-46 slice 3: the lines shown when a lone key, or any saved shortcut, can't be bound.
import { describe, expect, it } from 'vitest';
import {
  bootRefusedText, loneRefusedText, noneActiveText, usingInsteadText,
} from '../../src/features/settings/shortcutCopy';

const IM = 'System Settings › Privacy & Security › Input Monitoring';

describe('lone key refusal copy', () => {
  it('on macOS names Input Monitoring and where to allow it', () => {
    expect(loneRefusedText('AltRight', 'Ctrl + Shift + Space', true))
      .toBe(`⌥ (right) needs Input Monitoring. Allow Voxloom in ${IM}. Then record it again; relaunch Voxloom if that doesn't help. Kept ⌃⇧Space.`);
  });

  it('elsewhere says a lone key only works on macOS', () => {
    expect(loneRefusedText('F13', 'Ctrl + Shift + Space', false))
      .toBe('F13 on its own only works on macOS. Kept Ctrl+Shift+Space.');
  });

  it('the toast says "Using … instead", for a lone key and for a combo', () => {
    expect(usingInsteadText('AltRight', 'Ctrl + Shift + Space', true))
      .toBe(`⌥ (right) needs Input Monitoring. Allow Voxloom in ${IM}. Using ⌃⇧Space instead.`);
    expect(usingInsteadText('Ctrl + Alt + K', 'Ctrl + Shift + Space', true))
      .toBe('⌃⌥K is in use by another app. Using ⌃⇧Space instead.');
  });

  it('the launch toast covers both branches of a lone key and of a combo', () => {
    expect(bootRefusedText('AltRight', null, true))
      .toBe(`⌥ (right) needs Input Monitoring. Allow Voxloom in ${IM}. No shortcut is active. Record one in Settings.`);
    expect(bootRefusedText('F13', 'Ctrl + Shift + Space', false))
      .toBe('F13 on its own only works on macOS. Using Ctrl+Shift+Space instead. Record one in Settings.');
    expect(bootRefusedText('Ctrl + Alt + K', null, true))
      .toBe('⌃⌥K is in use by another app. No shortcut is active. Record one in Settings.');
    expect(bootRefusedText('Ctrl + Alt + K', 'Alt + J', true))
      .toBe('⌃⌥K is in use by another app. Using ⌥J instead. Record one in Settings.');
  });

  it('with nothing active, a lone key keeps its reason; a combo keeps the old line', () => {
    expect(noneActiveText('AltRight', 'Alt + J', true))
      .toBe(`⌥ (right) needs Input Monitoring. Allow Voxloom in ${IM}. No shortcut is active. Record one.`);
    expect(noneActiveText('Ctrl + Alt + T', 'Ctrl + Shift + Space', true))
      .toBe('Couldn\'t set ⌃⌥T or restore ⌃⇧Space. No shortcut is active. Record one.');
  });
});
