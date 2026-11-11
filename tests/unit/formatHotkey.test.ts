import { describe, expect, it } from 'vitest';
import { fromPluginHotkey, toPluginHotkey } from
  '../../src/services/shortcut/formatHotkey';

describe('toPluginHotkey', () => {
  it('converts Settings display strings to plugin format', () => {
    expect(toPluginHotkey('Ctrl + Shift + Space'))
      .toBe('Control+Shift+Space');
    expect(toPluginHotkey('Ctrl + Space')).toBe('Control+Space');
    expect(toPluginHotkey('Alt + D')).toBe('Alt+D');
  });
});

describe('fromPluginHotkey', () => {
  it('turns what native holds back into the stored Settings format', () => {
    expect(fromPluginHotkey('Control+Shift+Space')).toBe('Ctrl + Shift + Space');
    expect(fromPluginHotkey('Command+K')).toBe('Meta + K');
    expect(fromPluginHotkey('AltRight')).toBe('AltRight');
    expect(fromPluginHotkey('F13')).toBe('F13');
  });

  it('undoes toPluginHotkey for recorded shortcuts', () => {
    for (const stored of ['Ctrl + Alt + Shift + Meta + 1', 'Shift + Enter', 'Alt + D', 'ShiftRight', 'F19']) {
      expect(fromPluginHotkey(toPluginHotkey(stored))).toBe(stored);
    }
  });
});
