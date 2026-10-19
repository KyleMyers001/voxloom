// BUS-16 PR 2b: cleanup is opt-in. Older or hand-edited settings files must
// load with cleanup OFF and keep keys this build does not know.
import { describe, expect, it } from 'vitest';
import { initialSettings } from '../../src/domain/fixtures';
import {
  createMemorySettingsIo,
  createSettingsStore,
  parseSettingsJson,
  serializeSettingsFile,
} from '../../src/services/settings';
import { unknownSettingsKeys } from '../../src/services/settings/format';

describe('cleanup settings defaults', () => {
  it('defaults cleanup to off with no model selected', () => {
    expect(initialSettings.cleanupEnabled).toBe(false);
    expect(initialSettings.cleanupModelId).toBeNull();
    const parsed = parseSettingsJson(serializeSettingsFile(initialSettings, false));
    expect(parsed.ok && parsed.file.settings.cleanupEnabled).toBe(false);
  });

  it('loads a v1 file without cleanup keys as off and keeps unknown keys', () => {
    const raw = JSON.stringify({
      onboardingComplete: true,
      settings: { futureFlag: { nested: 1 }, style: 'casual' },
      version: 1,
    });
    const parsed = parseSettingsJson(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.settings).toMatchObject({
      cleanupEnabled: false,
      cleanupModelId: null,
      style: 'casual',
    });
    expect(unknownSettingsKeys(raw)).toEqual({ futureFlag: { nested: 1 } });
  });

  it('treats malformed cleanup values in a v2 file as off', () => {
    const parsed = parseSettingsJson(JSON.stringify({
      onboardingComplete: true,
      settings: { cleanupEnabled: 'yes', cleanupModelId: '' },
      version: 2,
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.settings.cleanupEnabled).toBe(false);
    expect(parsed.file.settings.cleanupModelId).toBeNull();
  });
});

describe('v1 settings never opt in to cleanup', () => {
  const v1WithCleanup = JSON.stringify({
    onboardingComplete: true,
    settings: {
      ...initialSettings,
      cleanupEnabled: true,
      cleanupModelId: 'local-cleanup-small',
      style: 'casual',
    },
    version: 1,
  });

  it('loads a #24-era v1 file with cleanupEnabled: true as off', () => {
    const parsed = parseSettingsJson(v1WithCleanup);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.settings.cleanupEnabled).toBe(false);
    expect(parsed.file.settings.style).toBe('casual');
    expect(parsed.file.version).toBe(2);
  });

  it('the durable store migrates it to a v2 file with cleanup off', async () => {
    const io = createMemorySettingsIo(v1WithCleanup);
    const loaded = await createSettingsStore(io).load();
    expect(loaded.ok && loaded.file.settings.cleanupEnabled).toBe(false);
    if (!loaded.ok) return;
    await createSettingsStore(io).save(loaded.file.settings, true);
    const written = JSON.parse(io.snapshot()!) as {
      settings: Record<string, unknown>; version: number;
    };
    expect(written.version).toBe(2);
    expect(written.settings.cleanupEnabled).toBe(false);
  });

  it('a v2 file can still opt in', () => {
    const parsed = parseSettingsJson(serializeSettingsFile(
      { ...initialSettings, cleanupEnabled: true }, true,
    ));
    expect(parsed.ok && parsed.file.settings.cleanupEnabled).toBe(true);
  });
});
