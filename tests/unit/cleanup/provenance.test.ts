import { webcrypto } from 'node:crypto';
import {
  CLEANUP_PROMPT_VERSION,
  skippedCleanupProvenance,
} from '../../../src/domain/cleanup';
import { CLEANUP_PROMPT_VERSION as SERVICE_PROMPT_VERSION } from '../../../src/services/cleanup/provenance';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CLEANUP_MODEL_SHA256,
  createCleanupProvenance,
} from '../../../src/services/cleanup';

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
});

describe('createCleanupProvenance', () => {
  it.each(['context-overflow', 'model-missing', 'runtime-error'] as const)(
    'does not infer an attempt from a preflight %s fallback', async (reason) => {
      const provenance = await createCleanupProvenance({
        dictionary: [], enabled: true, modelId: 'qwen3-0.6b-q4-k-m', style: 'formal',
      }, { finalText: 'raw', reason, status: 'fallback' });
      expect(provenance).toMatchObject({ modelId: null, modelDigest: null, reason });
    },
  );

  it('does not pair a model digest with a missing snapshot identity', async () => {
    const provenance = await createCleanupProvenance({
      dictionary: [], enabled: true, modelId: null, style: 'formal',
    }, { finalText: 'raw', reason: 'model-missing', status: 'fallback' });
    expect(provenance.modelDigest).toBeNull();
    expect(provenance.modelId).toBeNull();
  });
  it('records model and dictionary evidence for cleaned text', async () => {
    const provenance = await createCleanupProvenance({
      dictionary: ['Voxloom'],
      enabled: true,
      modelId: 'qwen3-0.6b-q4-k-m',
      style: 'formal',
    }, {
      attempt: { modelId: 'qwen3-0.6b-q4-k-m', modelDigest: CLEANUP_MODEL_SHA256 },
      finalText: 'Voxloom.',
      status: 'cleaned',
    });

    // New runs must be distinguishable from the real-model JSON-echo baseline.
    expect(provenance.promptVersion).toBe('cleanup-v2');
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
      attempt: { modelId: 'qwen3-0.6b-q4-k-m', modelDigest: CLEANUP_MODEL_SHA256 },
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

describe('shared cleanup prompt version', () => {
  it('skipped dogfood rows record the same prompt version as the service', () => {
    expect(skippedCleanupProvenance().promptVersion).toBe(CLEANUP_PROMPT_VERSION);
    expect(SERVICE_PROMPT_VERSION).toBe(CLEANUP_PROMPT_VERSION);
  });
});
