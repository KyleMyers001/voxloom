/**
 * BUS-86 / Codex P1 4394100513: a reload that finishes while a newer Off is
 * unconfirmed must not clear the divergence or re-allow writes, or a queued
 * snapshot wipes history.json before that Off is saved. Once the Off IS
 * confirmed, the wipe must still go through.
 */
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  addRecord, api, diskIds, FAIL, mountApp, setRetention, settle,
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

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { open, promise };
}

describe('Off retry during an in-flight rollback reload (P1 4394100513)', () => {
  it('keeps history.json intact until the retry is confirmed, then saves again after it fails', async () => {
    const m = await mountApp();
    const reload = gate();
    const retrySave = gate();
    m.ctl.load = async (n, inner, args) => {
      if (n === 1) await reload.promise;
      return inner.load(...args);
    };
    m.ctl.settingsSave = async (n) => {
      if (n === 2) await retrySave.promise;
      throw new Error(`disk full #${n}`);
    };
    await setRetention('off');
    await waitFor(() => expect(api().state.settingsError).toMatch(/disk full #1/));
    await setRetention('off');
    await waitFor(() => expect(api().state.settings.transcriptRetention).toBe('off'));
    reload.open();
    await settle(100);

    expect(m.save).not.toHaveBeenCalled();
    expect(diskIds(m.histIo.snapshot())).toEqual(['a', 'b']);

    retrySave.open();
    await waitFor(() => expect(api().state.settings.transcriptRetention).toBe('forever'));
    await settle(100);
    expect(diskIds(m.histIo.snapshot())).toEqual(['a', 'b']);
    expect(api().state.records.map((r) => r.id).sort()).toEqual(['a', 'b']);

    await addRecord('after');
    await waitFor(() => expect(diskIds(m.histIo.snapshot())).toEqual(['a', 'after', 'b']));
  });
});

type Third = 'succeeds' | 'fails' | 'held-succeeds' | 'held-fails';

/**
 * Off #1 save and its reload fail; Off #2 fails and its reload is held; Off #3
 * is requested. Its save resolves at once, or stays held until `resolveThird`.
 */
async function threeOffSaves(third: Third) {
  const m = await mountApp();
  const reload = gate();
  const thirdSave = gate();
  m.ctl.load = async (n, inner, args) => {
    if (n === 1) return FAIL;
    if (n === 2) await reload.promise;
    return inner.load(...args);
  };
  m.ctl.settingsSave = async (n) => {
    if (n === 3 && third.startsWith('held')) await thirdSave.promise;
    if (n <= 2 || third.endsWith('fails')) throw new Error(`disk full #${n}`);
  };
  await setRetention('off');
  await waitFor(() => expect(api().state.historyError).toMatch(/read failed/));
  await waitFor(() => expect(api().state.settings.transcriptRetention).toBe('forever'));
  await setRetention('off');
  await waitFor(() => expect(api().state.settingsError).toMatch(/disk full #2/));
  await setRetention('off');
  await settle();
  reload.open();
  await settle(150);
  return { ...m, resolveThird: thirdSave.open };
}

describe('three Off saves with a blocked history (CR repro at 1722777)', () => {
  it('Off #3 fails: history.json keeps a and b, retention is Forever, writes work again', async () => {
    const m = await threeOffSaves('fails');
    await waitFor(() => expect(api().state.settings.transcriptRetention).toBe('forever'));
    await settle(100);

    expect(diskIds(m.histIo.snapshot())).toEqual(['a', 'b']);
    await addRecord('after');
    await waitFor(() => expect(diskIds(m.histIo.snapshot())).toEqual(['a', 'after', 'b']));
  });

  it('Off #3 succeeds: the confirmed Off still wipes history.json', async () => {
    const m = await threeOffSaves('succeeds');

    await waitFor(() => expect(diskIds(m.histIo.snapshot())).toEqual([]));
    expect(api().state.settings.transcriptRetention).toBe('off');
    expect(api().state.historyError).toBeNull();
  });

  it('Off #3 save held, then fails: nothing is written while it is pending or after', async () => {
    const m = await threeOffSaves('held-fails');
    expect(m.save).not.toHaveBeenCalled();
    expect(diskIds(m.histIo.snapshot())).toEqual(['a', 'b']);

    m.resolveThird();
    await waitFor(() => expect(api().state.settings.transcriptRetention).toBe('forever'));
    await settle(100);
    expect(diskIds(m.histIo.snapshot())).toEqual(['a', 'b']);
    expect(api().state.records.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('Off #3 save held, then succeeds: no wipe while pending, then history.json is emptied', async () => {
    const m = await threeOffSaves('held-succeeds');
    expect(m.save).not.toHaveBeenCalled();
    expect(diskIds(m.histIo.snapshot())).toEqual(['a', 'b']);

    m.resolveThird();
    await waitFor(() => expect(diskIds(m.histIo.snapshot())).toEqual([]));
    expect(api().state.settings.transcriptRetention).toBe('off');
  });
});
