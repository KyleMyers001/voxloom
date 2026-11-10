import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AppProvider } from '../../src/app/AppContext';
import { Onboarding } from '../../src/features/onboarding/Onboarding';
import { initialSettings } from '../../src/domain/fixtures';
import type { SettingsLoadResult } from '../../src/services/settings';
import type { SetupBoundary } from '../../src/features/onboarding/guidedSetup';

const shortcut = 'Ctrl + Alt + K';
function deferredSettings() {
  let resolve!: (result: SettingsLoadResult) => void;
  const loading = new Promise<SettingsLoadResult>((done) => { resolve = done; });
  return {
    store: { load: () => loading, save: vi.fn(async () => {}) },
    hydrate: () => resolve({ ok: true, file: { version: 2, onboardingComplete: false, settings: { ...initialSettings, transcriptionModel: 'whisper-tiny.en', shortcut } } }),
  };
}
function boundary(): SetupBoundary {
  return {
    native: true, query: vi.fn(async () => ({ microphone: 'authorized', accessibility: 'authorized', inputMonitoring: 'authorized' } as const)),
    readiness: vi.fn(async (modelId) => ({ modelId, ready: true, reason: null })),
    request: vi.fn(), openSettings: vi.fn(), download: vi.fn(), cancelDownload: vi.fn(), activeShortcut: () => shortcut,
  };
}

it('preserves saved nondefault model, shortcut and completed hold through deferred durable hydration', async () => {
  const settings = deferredSettings();
  const io = boundary();
  const saved = JSON.stringify({ version: 1, step: 3, holdDone: true, tapDone: false, mode: 'tap', modelId: 'whisper-tiny.en', shortcut });
  let progress = saved;
  const storage = { read: () => progress, write: vi.fn((next: string) => { progress = next; }) };
  render(<AppProvider settingsPersistence={{ enabled: true, store: settings.store }}><Onboarding boundary={io} onClose={vi.fn()} progressStorage={storage} /></AppProvider>);
  await act(async () => {});
  const preHydrationProgress = progress;
  const preHydrationWrites = storage.write.mock.calls.length;
  await act(async () => settings.hydrate());
  await waitFor(() => expect(io.readiness).toHaveBeenCalledWith('whisper-tiny.en'));
  expect(JSON.parse(progress)).toMatchObject({ modelId: 'whisper-tiny.en', shortcut, holdDone: true, tapDone: false, mode: 'tap' });
  expect(preHydrationProgress).toBe(saved);
  expect(preHydrationWrites).toBe(0);
  expect(screen.getByRole('heading', { name: 'Now, go hands-free.' })).toBeInTheDocument();
});

it('does not expose enabled Start or trigger any setup boundary before settings hydrate', async () => {
  const settings = deferredSettings();
  const io = boundary();
  // Pending hashing makes the old Start path observable before it can settle.
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  io.readiness = vi.fn(async (modelId) => { await pending; return { modelId, ready: true, reason: null }; });
  const storage = { read: () => null, write: vi.fn() };
  render(<AppProvider settingsPersistence={{ enabled: true, store: settings.store }}><Onboarding boundary={io} onClose={vi.fn()} progressStorage={storage} /></AppProvider>);
  const start = screen.queryByRole('button', { name: /Start setup/ });
  if (start) fireEvent.click(start);
  const earlyDownloads = vi.mocked(io.download).mock.calls.slice();
  const earlyChecks = vi.mocked(io.readiness).mock.calls.slice();
  const earlyWrites = storage.write.mock.calls.length;
  await act(async () => { settings.hydrate(); release(); });
  expect(earlyDownloads).toEqual([]);
  expect(earlyChecks).toEqual([]);
  expect(earlyWrites).toBe(0);
  expect(start === null || start.hasAttribute('disabled')).toBe(true);
  expect(io.readiness).toHaveBeenCalledWith('whisper-tiny.en');
});
