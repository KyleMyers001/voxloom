/// BUS-57: a user cancel through the real Tauri path returns the row to
/// "Not downloaded" with no error and no Retry.
///
/// Native shape (src-tauri): `stt_cancel_download` resolves `null`; the pending
/// `stt_download_model` then rejects with `SttErrorDto::to_string_payload()`,
/// i.e. the JSON string `{"code":"cancelled","message":"Download cancelled: <id>"}`.
/// Until that rejection `stt_list_models` still reports `downloading` (the
/// inflight slot is cleared in the same step); only then does it say `missing`.
/// So the row can only reach "Not downloaded" through a post-cancel refresh.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  status: {} as Record<string, string>,
  reject: null as ((reason: unknown) => void) | null,
  listCalls: 0,
  listCallsAtReject: -1,
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string, args?: { modelId?: string }) => {
    const id = args?.modelId ?? '';
    switch (cmd) {
      case 'stt_list_models':
        native.listCalls += 1;
        return [
          { id: 'whisper-tiny.en', label: 'Whisper Tiny (English)', sizeBytes: 77_700_000, status: native.status['whisper-tiny.en'] ?? 'missing' },
          { id: 'whisper-base.en', label: 'Whisper Base (English)', sizeBytes: 148_000_000, status: native.status['whisper-base.en'] ?? 'missing' },
        ];
      case 'stt_download_model':
        native.status[id] = 'downloading';
        return new Promise((_, reject) => {
          native.reject = (reason) => {
            // Native clears inflight and the .partial as the download returns.
            native.status[id] = 'missing';
            native.listCallsAtReject = native.listCalls;
            reject(reason);
          };
        });
      case 'stt_cancel_download': {
        // Native only raises the cancel flag and resolves null; the download
        // loop notices on its next chunk and rejects a moment later.
        const reject = native.reject;
        native.reject = null;
        setTimeout(() => reject?.(JSON.stringify({ code: 'cancelled', message: `Download cancelled: ${id}` })), 30);
        return null;
      }
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { render } from '@testing-library/react';
import { ModelCard } from '../../src/features/settings/ModelCard';
import { useSttModels } from '../../src/services/stt/useSttModels';
import { createWhisperSttModelStore } from '../../src/services/stt/whisperAdapter';

const store = createWhisperSttModelStore();

/** ModelsTab's wiring (same hook + card, same swallow of the rejection)
 *  without the app shell, whose Tauri-only listeners need a real window. */
function Models() {
  const stt = useSttModels({ onSelect: () => {}, selectedModelId: 'whisper-tiny.en', store });
  return (
    <>
      {stt.error && <p role="alert">{stt.error}</p>}
      <ul>
        {stt.models.map((model) => (
          <ModelCard
            failure={stt.failures[model.id]}
            key={model.id}
            model={model}
            onCancel={() => { void stt.cancelDownload(model.id).catch(() => {}); }}
            onDownload={() => { void stt.downloadModel(model.id).catch(() => {}); }}
            onSelect={() => {}}
            progress={stt.progress?.modelId === model.id ? stt.progress : null}
            selected={false}
          />
        ))}
      </ul>
    </>
  );
}

describe('Models tab: native cancel (BUS-57)', () => {
  afterEach(() => {
    native.status = {};
    native.reject = null;
    native.listCalls = 0;
    native.listCallsAtReject = -1;
  });

  it('returns the row to Not downloaded with no error and no Retry', async () => {
    const user = userEvent.setup();
    render(<Models />);
    const row = (await screen.findByText('whisper-base.en')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Download' }));
    await user.click(await within(row).findByRole('button', { name: 'Cancel download' }));
    // Cancel resolved, but native still reports downloading: no Download yet.
    expect(native.status['whisper-base.en']).toBe('downloading');
    expect(within(row).queryByRole('button', { name: 'Download' })).toBeNull();

    await waitFor(() => expect(within(row).getByRole('button', { name: 'Download' })).toBeInTheDocument());
    // Download appeared only after the list was refreshed post-rejection.
    expect(native.listCallsAtReject).toBeGreaterThan(0);
    expect(native.listCalls).toBeGreaterThan(native.listCallsAtReject);
    expect(within(row).queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(within(row).queryByRole('alert')).toBeNull();
    expect(within(row).queryByText(/fail/i)).toBeNull();
    expect(within(row).queryByText(/cancell?ed/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
