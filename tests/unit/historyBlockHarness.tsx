/**
 * Shared harness for the history write-block tests (BUS-86). The importing
 * test file must vi.mock the three Tauri modules (isTauri → true).
 */
import { act, render, type RenderResult, waitFor } from '@testing-library/react';
import { expect, type Mock, vi } from 'vitest';
import { AppProvider, useApp } from '../../src/app/AppContext';
import { initialSettings } from '../../src/domain/fixtures';
import type { DictationRecord } from '../../src/domain/types';
import {
  createHistoryStore,
  createMemoryHistoryIo,
  serializeHistoryFile,
} from '../../src/services/history';
import {
  createMemorySettingsIo,
  createSettingsStore,
  serializeSettingsFile,
} from '../../src/services/settings';

export const NOW = Date.now();
export const FAIL = { ok: false as const, error: 'history.json read failed (I/O error)' };

export const settingsFile = (retention: 'off' | 'forever') =>
  serializeSettingsFile({ ...initialSettings, transcriptRetention: retention }, true);

export const rec = (id: string, createdAt = NOW - 1000): DictationRecord => ({
  createdAt,
  durationSeconds: 1,
  id,
  model: null,
  recoveryExpiresAt: null,
  status: 'inserted',
  style: 'formal',
  text: id,
});

let current: ReturnType<typeof useApp> | null = null;
export const api = (): ReturnType<typeof useApp> => current!;
function Probe() {
  current = useApp();
  return null;
}

export const settle = (ms = 40) =>
  act(async () => { await new Promise((r) => setTimeout(r, ms)); });

export const diskIds = (snapshot: string | null) =>
  (JSON.parse(snapshot!) as { records: { id: string }[] }).records.map((r) => r.id).sort();

type Inner = ReturnType<typeof createHistoryStore>;

export interface Control {
  armed: boolean;
  /** History load n (1-based, counted after arm). Default: real load. */
  load?: (n: number, inner: Inner, args: Parameters<Inner['load']>) => ReturnType<Inner['load']>;
  /** Settings save n (1-based, counted after arm). Throw to fail. */
  settingsSave?: (n: number) => Promise<void> | void;
}

export interface MountOptions {
  histBackupFails?: boolean;
  histBody?: string | null;
  settingsBackupFails?: boolean;
  settingsBody?: string;
}

export interface Mounted {
  before: string | null;
  ctl: Control;
  histIo: ReturnType<typeof createMemoryHistoryIo>;
  save: Mock<Inner['save']>;
  ui: RenderResult;
}

export async function mountApp(options: MountOptions = {}): Promise<Mounted> {
  const histIo = createMemoryHistoryIo(
    options.histBody === undefined ? serializeHistoryFile([rec('a'), rec('b')]) : options.histBody,
  );
  const inner = createHistoryStore(histIo);
  const ctl: Control = { armed: false };
  const save = vi.fn(inner.save);
  let loads = 0;
  const store: Inner = {
    ...inner,
    backup: options.histBackupFails ? async () => 'failed' as const : inner.backup,
    load: async (...args) => {
      if (!ctl.armed) return inner.load(...args);
      loads += 1;
      return ctl.load ? ctl.load(loads, inner, args) : inner.load(...args);
    },
    save,
  };
  const settingsIo = createMemorySettingsIo(
    options.settingsBody ?? settingsFile('forever'),
  );
  if (options.settingsBackupFails) {
    settingsIo.backup = async () => { throw new Error('backup denied'); };
  }
  const innerSettings = createSettingsStore(settingsIo);
  let settingsSaves = 0;
  const settingsStore = {
    ...innerSettings,
    save: async (...args: Parameters<typeof innerSettings.save>) => {
      if (ctl.armed) {
        settingsSaves += 1;
        await ctl.settingsSave?.(settingsSaves);
      }
      return innerSettings.save(...args);
    },
  };
  current = null;
  const ui = render(
    <AppProvider
      clock={() => NOW}
      historyPersistence={{ enabled: true, store }}
      settingsPersistence={{ enabled: true, store: settingsStore }}
    >
      <Probe />
    </AppProvider>,
  );
  await waitFor(() => expect(current?.bootReady).toBe(true));
  await settle();
  save.mockClear();
  ctl.armed = true;
  return { before: histIo.snapshot(), ctl, histIo, save, ui };
}

export const setRetention = (value: 'off' | 'forever') =>
  act(() => api().settings.update({ key: 'transcriptRetention', value }));

export const addRecord = (id: string) =>
  act(() => api().dispatch({ now: NOW, record: rec(id), type: 'append-record' }));
