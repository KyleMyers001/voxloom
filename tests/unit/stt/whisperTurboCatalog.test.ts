import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createMockSttModelStore } from '../../../src/services/stt/mockStt';
import { ensureModelAvailable } from '../../../src/services/stt/dogfoodModel';
import { isKnownSttModelId, resolveTranscriptionModelId } from '../../../src/services/stt/resolveModelId';
import { DEFAULT_STT_MODEL_ID, STT_MODEL_CATALOG } from '../../../src/services/stt/types';

const TURBO_ID = 'whisper-large-v3-turbo';

describe('optional English-first Whisper Large v3 Turbo', () => {
  it('registers the exact download size without changing the default', async () => {
    expect(STT_MODEL_CATALOG.find((model) => model.id === TURBO_ID)).toEqual({
      id: TURBO_ID,
      label: 'Whisper Large v3 Turbo (English)',
      sizeBytes: 1_624_555_275,
    });
    expect(DEFAULT_STT_MODEL_ID).toBe('whisper-tiny.en');
    expect(isKnownSttModelId(TURBO_ID)).toBe(true);
    expect(resolveTranscriptionModelId(TURBO_ID)).toBe(TURBO_ID);
    const store = createMockSttModelStore();
    expect(await store.status(TURBO_ID)).toMatchObject({ id: TURBO_ID, status: 'missing' });
    await expect(ensureModelAvailable(store, TURBO_ID)).rejects.toMatchObject({ code: 'model-missing' });
    await store.download(TURBO_ID);
    await expect(ensureModelAvailable(store, TURBO_ID)).resolves.toBe(TURBO_ID);
  });

  it('exercises the macOS accelerated Whisper feature in CI without downloading weights', () => {
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const commands = workflow.jobs['rust-macos'].steps.flatMap((step: { run?: string }) => step.run ? [step.run] : []);
    expect(commands).toContain('cargo test --locked --features whisper --lib');
  });

  it('ships the upstream Whisper license notices without bundling model weights', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const notice = 'licenses/whisper/THIRD-PARTY-NOTICES.txt';
    expect(config.bundle.resources?.[notice]).toBe(notice);
    const content = readFileSync(`src-tauri/${notice}`, 'utf8');
    expect(content).toContain('Copyright (c) 2022 OpenAI');
    expect(content).toContain('Copyright (c) 2023-2024 The ggml authors');
    expect(Object.keys(config.bundle.resources)).not.toContain('ggml-large-v3-turbo.bin');
  });
});
