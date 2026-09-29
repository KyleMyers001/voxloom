// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  isKnownSttModelId,
  resolveTranscriptionModelId,
} from '../../../src/services/stt/resolveModelId';
import { DEFAULT_STT_MODEL_ID } from '../../../src/services/stt/types';

describe('resolveTranscriptionModelId', () => {
  it('defaults empty / legacy simulated labels to tiny.en', () => {
    expect(resolveTranscriptionModelId('')).toBe(DEFAULT_STT_MODEL_ID);
    expect(resolveTranscriptionModelId(null)).toBe(DEFAULT_STT_MODEL_ID);
    expect(resolveTranscriptionModelId('Pine Voice Small · local')).toBe(
      DEFAULT_STT_MODEL_ID,
    );
    expect(
      resolveTranscriptionModelId('Pine Voice Medium · unavailable'),
    ).toBe(DEFAULT_STT_MODEL_ID);
  });

  it('passes through explicit catalog ids', () => {
    expect(resolveTranscriptionModelId('whisper-base.en')).toBe(
      'whisper-base.en',
    );
    expect(resolveTranscriptionModelId('  whisper-tiny.en  ')).toBe(
      'whisper-tiny.en',
    );
  });
});

describe('isKnownSttModelId', () => {
  it('recognizes catalog entries only', () => {
    expect(isKnownSttModelId('whisper-tiny.en')).toBe(true);
    expect(isKnownSttModelId('whisper-base.en')).toBe(true);
    expect(isKnownSttModelId('Pine Voice Small · local')).toBe(false);
  });
});
