// BUS-46 slice 1: lone-key tokens in the stored shortcut string.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { comboLabel, spokenCombo } from '../../src/components/KeyCombo';
import { initialSettings } from '../../src/domain/fixtures';
import { loneUnsupportedText, successText } from '../../src/features/settings/shortcutCopy';
import { parseSettingsJson, serializeSettingsFile } from '../../src/services/settings';
import { matchesShortcut, toPluginHotkey } from '../../src/services/shortcut/formatHotkey';
import { isLoneKey } from '../../src/services/shortcut/loneKey';
import { createNativeShortcutController, type NativeShortcutApi } from '../../src/services/shortcut/nativeRegistration';
import { captureShortcut } from '../../src/services/shortcut/shortcutCapture';

const ev = (code: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({
  altKey: false, code, ctrlKey: false, key: code, metaKey: false, shiftKey: false, ...mods,
});

describe('lone-key tokens', () => {
  it('recognises right-hand modifiers and F13-F19 only', () => {
    for (const k of ['AltRight', 'ControlRight', 'MetaRight', 'ShiftRight', 'F13', 'F19']) {
      expect(isLoneKey(k), k).toBe(true);
    }
    for (const k of ['AltLeft', 'F12', 'F20', 'K', 'Space', 'Alt + K', 'Ctrl + Shift + Space', '']) {
      expect(isLoneKey(k), k).toBe(false);
    }
  });

  it('never builds a plugin chord for a lone key; combos are unchanged', () => {
    expect(toPluginHotkey('AltRight')).toBe('AltRight');
    expect(toPluginHotkey('F13')).toBe('F13');
    expect(toPluginHotkey('Ctrl + Shift + Space')).toBe('Control+Shift+Space');
    expect(toPluginHotkey('Alt + D')).toBe('Alt+D');
  });

  it('matches a lone key by its physical code, left and right apart', () => {
    expect(matchesShortcut(ev('AltRight', { altKey: true }), 'AltRight')).toBe(true);
    expect(matchesShortcut(ev('AltLeft', { altKey: true }), 'AltRight')).toBe(false);
    expect(matchesShortcut(ev('F13'), 'F13')).toBe(true);
    expect(matchesShortcut(ev('F14'), 'F13')).toBe(false);
  });

  it('labels and speaks lone keys', () => {
    expect(comboLabel('AltRight', true)).toBe('⌥ (right)');
    expect(comboLabel('AltRight', false)).toBe('Alt (right)');
    expect(comboLabel('F13', true)).toBe('F13');
    expect(spokenCombo('AltRight', true)).toBe('Right Option');
    expect(spokenCombo('MetaRight', true)).toBe('Right Command');
    expect(spokenCombo('MetaRight', false)).toBe('Right Super');
    expect(comboLabel('Ctrl + Shift + Space', true)).toBe('⌃⇧Space');
  });

  it('captures F13-F19 alone, not with modifiers; other F-keys stay unsupported', () => {
    expect(captureShortcut(ev('F13'))).toEqual({ combo: 'F13', kind: 'captured' });
    expect(captureShortcut(ev('F19'))).toEqual({ combo: 'F19', kind: 'captured' });
    expect(captureShortcut(ev('F13', { altKey: true }))).toMatchObject({ invalid: { reason: 'f-key-combo' } });
    expect(captureShortcut(ev('F12'))).toMatchObject({ invalid: { reason: 'unsupported' } });
  });

  it('warns on Right Shift only', () => {
    expect(successText('ShiftRight', true)).toMatch(/Right ⇧ is also used for typing/);
    expect(successText('AltRight', true)).toBe('Shortcut set to ⌥ (right).');
  });
});

describe('settings compatibility', () => {
  it('loads an older file unchanged', () => {
    const raw = readFileSync('tests/fixtures/settings-v2-pr24.json', 'utf8');
    const parsed = parseSettingsJson(raw);
    expect(parsed.ok && parsed.file.settings.shortcut).toBe('Ctrl + Shift + Space');
  });

  it('gives a file without a shortcut the default', () => {
    const parsed = parseSettingsJson(JSON.stringify({ onboardingComplete: true, settings: {}, version: 1 }));
    expect(parsed.ok && parsed.file.settings.shortcut).toBe(initialSettings.shortcut);
  });

  it('round-trips a lone key through the settings file', () => {
    const raw = serializeSettingsFile({ ...initialSettings, shortcut: 'AltRight' }, true);
    const parsed = parseSettingsJson(raw);
    expect(parsed.ok && parsed.file.settings.shortcut).toBe('AltRight');
  });
});

describe('registration of a lone key (until the native listener lands)', () => {
  it('refuses it, never touches the plugin, and keeps the previous shortcut', async () => {
    const register = vi.fn<NativeShortcutApi['register']>(async () => undefined);
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      register,
      unregister: async () => undefined,
      unregisterAll: async () => undefined,
    };
    const onRegisterFailure = vi.fn();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdRelease: { arm: async () => false, disarm: async () => undefined, isAvailable: () => false, listen: async () => () => undefined },
      onGesture: () => undefined,
      onRegisterFailure,
      scheduler: { clear: () => undefined, set: () => 1 },
    });
    expect((await controller.setShortcut('Ctrl + Shift + Space')).ok).toBe(true);
    register.mockClear();
    const outcome = await controller.setShortcut('AltRight');
    expect(outcome.ok).toBe(false);
    expect(register.mock.calls.map(([hotkey]) => hotkey)).toEqual(['Control+Shift+Space']);
    expect(controller.activeHotkey()).toBe('Control+Shift+Space');
    expect(onRegisterFailure).toHaveBeenCalledOnce();
    expect(loneUnsupportedText('AltRight', 'Ctrl + Shift + Space', true))
      .toBe('⌥ (right) on its own isn\'t supported in this build yet. Kept ⌃⇧Space.');
  });
});
