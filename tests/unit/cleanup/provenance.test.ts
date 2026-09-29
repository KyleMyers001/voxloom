import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CLEANUP_MODEL_SHA256,
  createCleanupProvenance,
} from '../../../src/services/cleanup';

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
});

describe('createCleanupProvenance', () => {
  it('records model and dictionary evidence for cleaned text', async () => {
    const provenance = await createCleanupProvenance({
      dictionary: ['Voxloom'],
      enabled: true,
      modelId: 'qwen3-0.6b-q4-k-m',
      style: 'formal',
    }, {
      finalText: 'Voxloom.',
      status: 'cleaned',
    });

    expect(provenance.dictionaryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance.modelDigest).toBe(CLEANUP_MODEL_SHA256);
    expect(provenance.status).toBe('cleaned');
  });

  it('keeps fallback reason without claiming model output', async () => {
    const provenance = await createCleanupProvenance({
      dictionary: [],
      enabled: true,
      modelId: 'qwen3-0.6b-q4-k-m',
      style: 'casual',
    }, {
      finalText: 'raw',
      reason: 'timeout',
      status: 'fallback',
    });

    expect(provenance.modelDigest).toBe(CLEANUP_MODEL_SHA256);
    expect(provenance.modelId).toBe('qwen3-0.6b-q4-k-m');
    expect(provenance.reason).toBe('timeout');
    expect(provenance.status).toBe('fallback');
  });
});
