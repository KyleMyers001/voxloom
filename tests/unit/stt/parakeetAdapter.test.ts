// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
import { prepareSttSession } from '../../../src/services/stt/prepareSession';
import { createSttEngine } from '../../../src/services/stt/factory';

describe('Parakeet native request adapter', () => {
  it.each(['pending', 'rejected', 'cancelled'] as const)('disposes stopped PCM independently of %s preparation retirement', async (state) => {
    let admit!: () => void;
    let reject!: (error: unknown) => void;
    invoke.mockImplementation((command: string) => command === 'stt_prepare'
      ? new Promise<void>((resolve, fail) => { admit = resolve; reject = fail; })
      : Promise.resolve());
    const prepared = prepareSttSession('parakeet-tdt-0.6b-v3')!;
    const admission = prepared.admission.catch(() => {});
    const cancellation = prepared.cancel().catch(() => {});
    if (state === 'rejected') reject({ code: 'busy' });
    else if (state === 'cancelled') admit();
    if (state !== 'pending') await cancellation;
    await prepared.release('stopped-pcm');
    expect(invoke).toHaveBeenLastCalledWith('stt_release', { requestId: prepared.requestId, bufferId: 'stopped-pcm' });
    expect(invoke.mock.calls.filter(([c]) => c === 'stt_transcribe')).toHaveLength(0);
    // Finish the blocked admission only after proving disposal did not await it.
    if (state === 'pending') admit();
    await Promise.all([admission, cancellation]);
    expect(invoke.mock.calls.filter(([c]) => c === 'stt_cancel')).toHaveLength(state === 'rejected' ? 0 : 1);
  });
  it.each(['busy', 'unsupported-platform', 'timeout'])('keeps the native %s admission error without starting inference', async (code) => {
    invoke.mockRejectedValue({ code, message: 'Parakeet unavailable' });
    const prepared = prepareSttSession('parakeet-tdt-0.6b-v2')!;
    await expect(prepared.admission).rejects.toMatchObject({ code });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => { invoke.mockReset().mockResolvedValue(undefined); });
  it('prepares one request and passes its identity to transcription without changing filter behavior', async () => {
    const prepared = prepareSttSession('parakeet-tdt-0.6b-v3')!;
    await prepared.admission;
    expect(invoke).toHaveBeenCalledWith('stt_prepare', { modelId: 'parakeet-tdt-0.6b-v3', requestId: prepared.requestId });
    invoke.mockResolvedValue({ text: 'bonjour', language: null });
    await expect(createSttEngine('parakeet-tdt-0.6b-v3', prepared.requestId).transcribe({ id: 'pcm', durationMs: 10, sampleRateHz: 16000 })).resolves.toMatchObject({ language: null });
    expect(invoke).toHaveBeenLastCalledWith('stt_transcribe', { modelId: 'parakeet-tdt-0.6b-v3', requestId: prepared.requestId, bufferId: 'pcm', filter: null });
    await prepared.release();
    expect(invoke).toHaveBeenLastCalledWith('stt_release', { requestId: prepared.requestId });
  });
});
