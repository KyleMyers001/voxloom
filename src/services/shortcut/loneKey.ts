/**
 * BUS-46: a lone key is a whole shortcut on its own: a right-hand modifier
 * ("AltRight") or one of F13-F19. It is stored in the existing
 * `settings.shortcut` string as the physical KeyboardEvent.code, so older
 * files and every "A + B" combo keep their meaning. Left-hand modifiers are
 * not offered: they are part of everyday typing.
 */

export type LoneModifierCode =
  | 'AltRight' | 'ControlRight' | 'MetaRight' | 'ShiftRight';

const MODIFIERS: Record<LoneModifierCode, { glyph: string; word: string; mac: string; other: string }> = {
  AltRight: { glyph: '⌥', mac: 'Option', other: 'Alt', word: 'Alt' },
  ControlRight: { glyph: '⌃', mac: 'Control', other: 'Control', word: 'Ctrl' },
  MetaRight: { glyph: '⌘', mac: 'Command', other: 'Super', word: 'Super' },
  ShiftRight: { glyph: '⇧', mac: 'Shift', other: 'Shift', word: 'Shift' },
};

const F_KEY = /^F(1[3-9])$/;

/** Firefox reports Meta as "OS": fold it onto the codes used everywhere else. */
export function normalizeModifierCode(code: string): string {
  if (code === 'OSRight') return 'MetaRight';
  if (code === 'OSLeft') return 'MetaLeft';
  return code;
}

export function isLoneModifier(code: string): code is LoneModifierCode {
  return Object.hasOwn(MODIFIERS, code);
}

/** True for a left-hand modifier (Alt/Control/Meta/Shift Left), which can't be a shortcut on its own. */
export function isLeftModifier(code: string): boolean {
  return ['AltLeft', 'ControlLeft', 'MetaLeft', 'ShiftLeft'].includes(code);
}

export function isLoneFKey(code: string): boolean {
  return F_KEY.test(code);
}

/**
 * The stored token for a lone key, or null for an "A + B" combo. Case does
 * not matter ("f13", "altright"): a hand-edited or older file must not slip
 * past as a plugin chord (BUS-155 L3).
 */
export function canonicalLoneKey(shortcut: string): string | null {
  const code = shortcut.trim();
  const modifier = Object.keys(MODIFIERS).find((name) => name.toLowerCase() === code.toLowerCase());
  if (modifier) return modifier;
  return F_KEY.test(code.toUpperCase()) ? code.toUpperCase() : null;
}

/** True for a stored shortcut that is a lone key, not an "A + B" combo. */
export function isLoneKey(shortcut: string): boolean {
  return canonicalLoneKey(shortcut) !== null;
}

/** Cap labels: "⌥ (right)" on macOS, "Alt (right)" elsewhere; F-keys as is. */
export function loneKeyKeys(shortcut: string, mac: boolean): string[] | null {
  const code = canonicalLoneKey(shortcut) ?? shortcut.trim();
  if (isLoneFKey(code)) return [code];
  if (!isLoneModifier(code)) return null;
  const m = MODIFIERS[code];
  return [`${mac ? m.glyph : m.word} (right)`];
}

/** What VoiceOver should say: "Right Option", "Right Alt", "F13". */
export function spokenLoneKey(shortcut: string, mac: boolean): string | null {
  const code = canonicalLoneKey(shortcut) ?? shortcut.trim();
  if (isLoneFKey(code)) return code;
  if (!isLoneModifier(code)) return null;
  return `Right ${mac ? MODIFIERS[code].mac : MODIFIERS[code].other}`;
}

/** The right-hand modifier to suggest for a left-hand code ("AltLeft" → "AltRight"). */
export function rightHandOf(code: string): LoneModifierCode | null {
  const right = code.replace(/Left$/, 'Right');
  return isLoneModifier(right) ? right : null;
}
