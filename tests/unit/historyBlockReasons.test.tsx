/**
 * BUS-86: only a block caused by an unreadable boot/reload load is lifted by
 * a later successful reload. Read-only boots and delete-patch blocks stay
 * blocked for the session, even after another reload failed in between.
 */
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  addRecord, api, diskIds, FAIL, mountApp, type Mounted, NOW, rec, setRetention, settingsFile, settle,
} from './historyBlockHarness';
import { serializeHistoryFile } from '../../src/services/history';

const bus = vi.hoisted(() => ({
  listeners: [] as ((e: { payload: unknown }) => void)[],
}));
vi.mock('@tauri-apps/api/core', async (importActual) => ({
  ...(await importActual<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_event: string, handler: (e: { payload: unknown }) => void) => {
    bus.listeners.push(handler);
    return Promise.resolve(() => {});
  },
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}));

const BAD_SETTINGS = '{bad settings';
const changeStyle = () => act(() => api().settings.update({ key: 'style', value: 'casual' } as never));

/** Off save #1 fails; history load #1 fails when `reloadFails`. */
async function offFails(m: Mounted, reloadFails: boolean) {
  let reloads = 0;
  m.ctl.load = async (n, inner, args) => {
    reloads += 1;
    return reloadFails && n === 1 ? FAIL : inner.load(...args);
  };
  m.ctl.settingsSave = (n) => { if (n === 1) throw new Error('disk full'); };
  await setRetention('off');
  await waitFor(() => expect(api().state.settingsError).toMatch(/disk full/));
  await waitFor(() => expect(reloads).toBeGreaterThan(0));
  await waitFor(() => expect(api().state.settings.transcriptRetention).not.toBe('off'));
  await settle(80);
}

describe('read-only boot (history backup failed after a settings reset)', () => {
  it('a successful reload keeps writes blocked and the read-only error', async () => {
    const m = await mountApp({ histBackupFails: true, settingsBody: BAD_SETTINGS });
    expect(api().state.historyError).toMatch(/read-only because it couldn't be backed up/);
    await offFails(m, false);
    await addRecord('new');
    await settle(80);

    expect(m.save).not.toHaveBeenCalled();
    expect(m.histIo.snapshot()).toBe(m.before);
    expect(api().state.historyError).toMatch(/read-only/);
  });

  it('a failed reload, then a successful one, still never writes', async () => {
    const m = await mountApp({ histBackupFails: true, settingsBody: BAD_SETTINGS });
    await offFails(m, true);
    m.ctl.load = undefined;
    await changeStyle();
    await settle(100);
    await addRecord('new');
    await settle(80);

    expect(m.save).not.toHaveBeenCalled();
    expect(m.histIo.snapshot()).toBe(m.before);
  });

  it('does not prune a row older than the reset 30-day retention', async () => {
    const old = rec('old-90d', NOW - 90 * 86_400_000);
    const m = await mountApp({
      histBackupFails: true,
      histBody: serializeHistoryFile([old, rec('recent')]),
      settingsBody: BAD_SETTINGS,
    });
    await offFails(m, true);
    m.ctl.load = undefined;
    await changeStyle();
    await settle(100);
    await addRecord('new');
    await settle(80);

    expect(diskIds(m.histIo.snapshot())).toContain('old-90d');
  });
});

describe('settings unreadable at boot, then repaired by another window', () => {
  it('a failed reload, then a successful one, still never writes history.json', async () => {
    const m = await mountApp({ settingsBackupFails: true, settingsBody: BAD_SETTINGS });
    expect(api().state.historyError).toMatch(/read-only until settings can be read/);
    await waitFor(() => expect(bus.listeners.length).toBeGreaterThan(0));
    act(() => bus.listeners.forEach((l) => l({
      payload: { contents: settingsFile('forever'), source: 'settings' },
    })));
    await settle(80);
    await offFails(m, true);
    m.ctl.load = undefined;
    await changeStyle();
    await settle(100);
    await addRecord('new');
    await settle(80);

    expect(m.save).not.toHaveBeenCalled();
    expect(m.histIo.snapshot()).toBe(m.before);
  });
});

describe('delete-patch block (BUS-90 class)', () => {
  it('a later successful reload never re-allows writes, so revived rows are not persisted', async () => {
    const m = await mountApp();
    let releaseOff: () => void = () => {};
    const offHeld = new Promise<void>((resolve) => { releaseOff = resolve; });
    m.ctl.load = async (n, inner, args) => (n === 1 ? FAIL : inner.load(...args));
    m.ctl.settingsSave = async (n) => {
      if (n === 1) { await offHeld; throw new Error('disk full'); }
    };
    await setRetention('off');
    await waitFor(() => expect(api().state.settings.transcriptRetention).toBe('off'));
    act(() => api().history.delete('a'));
    await waitFor(() => expect(api().state.historyError).toMatch(/read failed/));
    releaseOff();
    await waitFor(() => expect(api().state.settings.transcriptRetention).toBe('forever'));
    await settle(100);
    await addRecord('new');
    await settle(80);

    expect(m.save).not.toHaveBeenCalled();
    expect(m.histIo.snapshot()).toBe(m.before);
    expect(api().state.historyError).toMatch(/read failed/);
  });
});
