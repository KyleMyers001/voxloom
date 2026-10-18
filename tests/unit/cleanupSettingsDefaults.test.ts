// BUS-16 PR 2b: cleanup is opt-in. Older or hand-edited settings files must
// load with cleanup OFF and keep keys this build does not know.
import { describe, expect, it } from 'vitest';
import { initialSettings } from '../../src/domain/fixtures';
import {
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
