import { expect, it } from 'vitest';
import { defaultSettingsFile, parseSettingsJson } from '../../src/services/settings/format';
import { DEFAULT_STT_MODEL_ID, STT_MODEL_CATALOG } from '../../src/services/stt/types';

it('recommends exact pinned Base English for a new user without migrating explicit existing choices', () => {
  expect(DEFAULT_STT_MODEL_ID).toBe('whisper-base.en');
  expect(defaultSettingsFile().settings.transcriptionModel).toBe('whisper-base.en');
  expect(STT_MODEL_CATALOG.find((model) => model.id === 'whisper-base.en')?.sizeBytes).toBe(147964211);
  for (const transcriptionModel of ['whisper-tiny.en', 'whisper-base.en', 'whisper-large-v3-turbo', 'parakeet-tdt-0.6b-v3']) {
    const parsed = parseSettingsJson(JSON.stringify({ version: 2, settings: { transcriptionModel }, onboardingComplete: true }));
    expect(parsed.ok && parsed.file.settings.transcriptionModel).toBe(transcriptionModel);
  }
});
