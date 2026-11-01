// BUS-46 slice 1: lone-key tokens in the stored shortcut string.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { comboLabel, spokenCombo } from '../../src/components/KeyCombo';
import { initialSettings } from '../../src/domain/fixtures';
import { successText } from '../../src/features/settings/shortcutCopy';
import { parseSettingsJson, serializeSettingsFile } from '../../src/services/settings';
import { matchesShortcut, toPluginHotkey } from '../../src/services/shortcut/formatHotkey';
import { canonicalLoneKey, isLoneKey } from '../../src/services/shortcut/loneKey';
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

  it('treats a hand-edited lowercase token as the same lone key (L3)', () => {
    expect(canonicalLoneKey('f13')).toBe('F13');
    expect(canonicalLoneKey(' altright ')).toBe('AltRight');
    expect(isLoneKey('f13')).toBe(true);
    expect(toPluginHotkey('f13')).toBe('F13');
    expect(toPluginHotkey('altright')).toBe('AltRight');
    expect(canonicalLoneKey('f20')).toBeNull();
    expect(matchesShortcut(ev('F13'), 'f13')).toBe(true);
  });

  it('matches a lone key by its physical code, left and right apart', () => {
    expect(matchesShortcut(ev('AltRight', { altKey: true }), 'AltRight')).toBe(true);
    expect(matchesShortcut(ev('AltLeft', { altKey: true }), 'AltRight')).toBe(false);
    expect(matchesShortcut(ev('F13'), 'F13')).toBe(true);
    expect(matchesShortcut(ev('F14'), 'F13')).toBe(false);
  });

  it('a lone key press needs every other modifier up; its release matches by code', () => {
    expect(matchesShortcut(ev('AltRight', { altKey: true, shiftKey: true }), 'AltRight')).toBe(false);
    expect(matchesShortcut(ev('AltRight', { altKey: true, metaKey: true }), 'AltRight')).toBe(false);
    expect(matchesShortcut(ev('ShiftRight', { shiftKey: true }), 'ShiftRight')).toBe(true);
    expect(matchesShortcut(ev('ControlRight', { ctrlKey: true, altKey: true }), 'ControlRight')).toBe(false);
    expect(matchesShortcut(ev('F13', { shiftKey: true }), 'F13')).toBe(false);
    expect(matchesShortcut(ev('F13', { metaKey: true }), 'F13')).toBe(false);
    // A release ends a hold even if Shift went down meanwhile.
    expect(matchesShortcut(ev('AltRight', { shiftKey: true }), 'AltRight', 'up')).toBe(true);
    expect(matchesShortcut(ev('AltLeft'), 'AltRight', 'up')).toBe(false);
    // Combos are unchanged.
    expect(matchesShortcut(ev('KeyK', { altKey: true }), 'alt + k', 'up')).toBe(true);
    expect(matchesShortcut(ev('KeyK', { altKey: true, shiftKey: true }), 'alt + k')).toBe(false);
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
