// BUS-16 PR 2c: cleanup runs only with cleanupEnabled AND the explicit opt-in
// key the 2c Settings UI writes. A #24-era v2 file has cleanupEnabled: true
// but no opt-in, and must stay off.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isCleanupActive } from '../../src/domain/cleanup';
import { initialSettings } from '../../src/domain/fixtures';
import {
  createMemorySettingsIo,
  createSettingsStore,
  parseSettingsJson,
  serializeSettingsFile,
} from '../../src/services/settings';

const pr24File = readFileSync('tests/fixtures/settings-v2-pr24.json', 'utf8');

describe('explicit cleanup opt-in', () => {
  it('defaults to off', () => {
    expect(initialSettings.cleanupOptIn).toBe(false);
    expect(isCleanupActive(initialSettings)).toBe(false);
  });

  it('a #24-era v2 file with cleanupEnabled: true and no opt-in does not run cleanup', () => {
    const parsed = parseSettingsJson(pr24File);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.settings).toMatchObject({
      cleanupEnabled: true,
      cleanupModelId: 'qwen3-0.6b-q4-k-m',
      cleanupOptIn: false,
      style: 'casual',
    });
    expect(isCleanupActive(parsed.file.settings)).toBe(false);
  });

  it('the store loads and rewrites that file without opting in', async () => {
    const io = createMemorySettingsIo(pr24File);
    const loaded = await createSettingsStore(io).load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(isCleanupActive(loaded.file.settings)).toBe(false);
    await createSettingsStore(io).save(loaded.file.settings, true);
    const reread = parseSettingsJson(io.snapshot()!);
    expect(reread.ok && isCleanupActive(reread.file.settings)).toBe(false);
  });

  it('needs both keys', () => {
    expect(isCleanupActive({ cleanupEnabled: true, cleanupOptIn: false })).toBe(false);
    expect(isCleanupActive({ cleanupEnabled: false, cleanupOptIn: true })).toBe(false);
    expect(isCleanupActive({ cleanupEnabled: true, cleanupOptIn: true })).toBe(true);
  });

  it('a v2 file written with both keys round-trips as active', () => {
    const parsed = parseSettingsJson(serializeSettingsFile(
      { ...initialSettings, cleanupEnabled: true, cleanupOptIn: true }, true,
    ));
    expect(parsed.ok && isCleanupActive(parsed.file.settings)).toBe(true);
  });

  it.each([['yes'], [1], [null], ['true']])('a malformed opt-in (%j) loads as off', (value) => {
    const parsed = parseSettingsJson(JSON.stringify({
      onboardingComplete: true,
      settings: { cleanupEnabled: true, cleanupOptIn: value },
      version: 2,
    }));
    expect(parsed.ok && parsed.file.settings.cleanupOptIn).toBe(false);
  });

  it('a v1 file never opts in, even with both keys', () => {
    const parsed = parseSettingsJson(JSON.stringify({
      onboardingComplete: true,
      settings: { cleanupEnabled: true, cleanupOptIn: true },
      version: 1,
    }));
    expect(parsed.ok && isCleanupActive(parsed.file.settings)).toBe(false);
  });
});
