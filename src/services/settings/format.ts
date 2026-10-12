import { initialSettings } from '../../domain/fixtures';
import {
  audioRetentions,
  transcriptRetentions,
  writingStyles,
} from '../../domain/settings';
import type { Appearance, Settings, WritingStyle } from '../../domain/types';

/** On-disk schema version for `settings.json`. */
export const SETTINGS_FILE_VERSION = 1 as const;

export interface SettingsFile {
  onboardingComplete: boolean;
  settings: Settings;
  version: typeof SETTINGS_FILE_VERSION;
}

const APPEARANCES: readonly Appearance[] = [
  'system',
  'light',
  'dark',
  'sodium-rain',
];

export type ParseSettingsResult =
  | { ok: true; file: SettingsFile }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asChoice<const Choices extends readonly string[]>(
  value: unknown,
  choices: Choices,
  fallback: Choices[number],
): Choices[number] {
  if (typeof value === 'string' && choices.includes(value)) {
    return value as Choices[number];
  }
  return fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Merge a partial/unknown settings object onto defaults.
 * Invalid individual fields fall back; does not throw.
 */
export function coerceSettings(raw: unknown): Settings {
  const base = { ...initialSettings };
  if (!isObject(raw)) return base;
  return {
    appearance: asChoice(raw.appearance, APPEARANCES, base.appearance),
    audioRetention: asChoice(
      raw.audioRetention,
      audioRetentions,
      base.audioRetention,
    ),
    clipboardFallback: asBoolean(raw.clipboardFallback, base.clipboardFallback),
    language: asString(raw.language, base.language),
    languageModel: asString(raw.languageModel, base.languageModel),
    microphone: asString(raw.microphone, base.microphone),
    shortcut: asString(raw.shortcut, base.shortcut),
    startAtLogin: asBoolean(raw.startAtLogin, base.startAtLogin),
    style: asChoice(
      raw.style,
      writingStyles,
      base.style,
    ) as WritingStyle,
    transcriptRetention: asChoice(
      raw.transcriptRetention,
      transcriptRetentions,
      base.transcriptRetention,
    ),
    transcriptionModel: asString(
      raw.transcriptionModel,
      base.transcriptionModel,
    ),
  };
}

/**
 * Parse and validate a settings JSON document.
 * Corrupt / unknown version → error (caller uses defaults; must not wipe
 * history.json). Missing file is handled by the store before parse.
 * Individual invalid fields coerce to defaults inside a valid envelope.
 */
export function parseSettingsJson(raw: string): ParseSettingsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { error: 'Settings file is not valid JSON', ok: false };
  }
  if (!isObject(parsed)) {
    return { error: 'Settings file root must be an object', ok: false };
  }
  // v2 was written by the BUS-16 cleanup branch (#24): same envelope plus
  // cleanup fields this build ignores (BUS-42).
  if (parsed.version !== SETTINGS_FILE_VERSION && parsed.version !== 2) {
    return {
      error: `Unsupported settings file version: ${String(parsed.version)}`,
      ok: false,
    };
  }
  const onboardingComplete = asBoolean(parsed.onboardingComplete, false);
  const settings = coerceSettings(parsed.settings);
  return {
    file: {
      onboardingComplete,
      settings,
      version: SETTINGS_FILE_VERSION,
    },
    ok: true,
  };
}

/**
 * Keys of the on-disk `settings` object this build does not know (e.g. #24's
 * `cleanupEnabled` / `cleanupModelId`). They never reach app state, but are
 * written back on save so another build's settings are not lost (BUS-42).
 */
export function unknownSettingsKeys(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (!isObject(parsed) || !isObject(parsed.settings)) return {};
  const known = new Set(Object.keys(initialSettings));
  // Null prototype: a `__proto__` key is stored as data, not swallowed.
  const extras = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed.settings)) {
    if (!known.has(key)) extras[key] = value;
  }
  return extras;
}

export function serializeSettingsFile(
  settings: Settings,
  onboardingComplete: boolean,
  extras: Record<string, unknown> = {},
): string {
  const file = {
    onboardingComplete,
    // Coerced values are authoritative for every key this build knows.
    settings: { ...extras, ...settings },
    version: SETTINGS_FILE_VERSION,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function defaultSettingsFile(): SettingsFile {
  return {
    onboardingComplete: false,
    settings: { ...initialSettings },
    version: SETTINGS_FILE_VERSION,
  };
}
