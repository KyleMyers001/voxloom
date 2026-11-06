import { readFileSync } from 'node:fs';
import { STT_MODEL_CATALOG } from '../../../src/services/stt/types';
import { describe, expect, it } from 'vitest';
import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { ensureModelAvailable } from '../../../src/services/stt/dogfoodModel';
import { isKnownSttModelId, resolveTranscriptionModelId } from '../../../src/services/stt/resolveModelId';

describe('Parakeet inventory', () => {
  it.each(['v2', 'v3'])('uses the sum of pinned native file metadata for the %s catalog size', (version) => {
    const manifest = readFileSync(`src-tauri/src/stt/parakeet-manifests/${version}.rs`, 'utf8');
    const sizes = [...manifest.matchAll(/size_bytes: (\d+)/g)].map((match) => Number(match[1]));
    expect(sizes).toHaveLength(21);
    expect(STT_MODEL_CATALOG.find((m) => m.id === `parakeet-tdt-0.6b-${version}`)?.sizeBytes).toBe(sizes.reduce((sum, size) => sum + size, 0));
  });
  it.each(['parakeet-tdt-0.6b-v2', 'parakeet-tdt-0.6b-v3'])('exposes %s for explicit download and selection without Whisper fallback', async (id) => {
    const store = createMockSttModelStore();
    expect(isKnownSttModelId(id)).toBe(true);
    expect(resolveTranscriptionModelId(id)).toBe(id);
    expect(await store.status(id)).toMatchObject({ id, status: 'missing' });
    await store.download(id);
    expect(await ensureModelAvailable(store, id)).toBe(id);
  });
});
