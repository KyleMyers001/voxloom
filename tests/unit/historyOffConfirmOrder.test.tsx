/**
 * BUS-86: an Off confirmed while history writes are blocked by an unreadable
 * load must read history.json again and only then wipe it (writes are blocked
 * until that read succeeds). Dropping the reload leaves the transcripts on disk.
 * Swapping the queued reload and snapshot is an equivalent change: the reload's
 * hydrate effect also writes the wipe, so the order is not observable.
 */
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  api, diskIds, FAIL, mountApp, setRetention, settle,
} from './historyBlockHarness';

vi.mock('@tauri-apps/api/core', async (importActual) => ({
  ...(await importActual<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}));

describe('confirmed Off while history is load-blocked', () => {
  it('reloads history.json, then wipes it', async () => {
    const m = await mountApp();
    const events: string[] = [];
    const realSave = m.save.getMockImplementation()!;
    m.save.mockImplementation(async (...args) => {
      events.push('save');
      return realSave(...args);
    });
    // Off #1 fails and its rollback reload fails: blocked, memory still Off-filtered.
    m.ctl.settingsSave = async (n) => { if (n === 1) throw new Error('disk full'); };
    m.ctl.load = async (n, inner, args) => {
      events.push(`load${n}`);
      return n === 1 ? FAIL : inner.load(...args);
    };
    await setRetention('off');
    await waitFor(() => expect(api().state.historyError).toMatch(/read failed/));
    expect(diskIds(m.histIo.snapshot())).toEqual(['a', 'b']);

    await setRetention('off'); // Off #2 is confirmed
    await waitFor(() => expect(diskIds(m.histIo.snapshot())).toEqual([]));
    await settle(60);

    expect(api().state.settings.transcriptRetention).toBe('off');
    // The hydrate effect may add a second (identical) wipe; the order is what matters.
    expect(events.slice(0, 3)).toEqual(['load1', 'load2', 'save']);
  });
});
