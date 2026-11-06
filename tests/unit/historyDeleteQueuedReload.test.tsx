/**
 * BUS-86 / Codex P2 4394604089: a Delete made while the rollback reload is
 * still queued behind an in-flight history save must be remembered by that
 * reload, or the reload restores the row and the queued delete patch (which
 * only runs while an Off is pending) skips it. Every read and write succeeds.
 */
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  addRecord, api, diskIds, mountApp, setRetention, settle,
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

describe('Delete while the rollback reload is queued behind a history save (P2 4394604089)', () => {
  it('does not bring the deleted row back, in memory or on disk', async () => {
    const m = await mountApp();
    const realSave = m.save.getMockImplementation()!;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    m.save.mockImplementationOnce(async (...args) => {
      await held;
      return realSave(...args);
    });
    m.ctl.settingsSave = async () => { throw new Error('disk full'); };

    await addRecord('c'); // history save in flight (held)
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    await setRetention('off');
    await waitFor(() => expect(api().state.settingsError).toMatch(/disk full/));
    api().history.delete('a'); // the rollback reload is queued behind the save
    release();
    await settle(150);

    expect(api().state.settings.transcriptRetention).toBe('forever');
    expect(api().state.records.map((r) => r.id).sort()).toEqual(['b', 'c']);
    expect(diskIds(m.histIo.snapshot())).toEqual(['b', 'c']);
  });
});
