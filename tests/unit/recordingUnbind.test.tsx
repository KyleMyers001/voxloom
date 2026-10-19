// BUS-69: the OS hotkey is unbound while a recorder records, so re-recording
// the current shortcut reaches the recorder, and is re-bound afterwards.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../../src/services/contracts';
import { ShortcutRecorder } from '../../src/features/settings/ShortcutRecorder';
import { resetRecorderStore } from '../../src/features/settings/recorderStore';
import { successText } from '../../src/features/settings/shortcutCopy';
import {
  applyRemoteLease, beginRecordingSuspend, LEASE_MS, resetRecordingSuspend,
} from '../../src/services/shortcut/recordingSuspend';
import { UNBIND_RECHECK_MS, unbindWhileRecording } from '../../src/services/shortcut/recordingUnbind';
import { createNativeShortcutController, type NativeShortcutApi } from '../../src/services/shortcut/nativeRegistration';
import type { HoldReleaseApi } from '../../src/services/shortcut/holdReleaseBridge';

afterEach(() => {
  resetRecordingSuspend();
  resetRecorderStore();
  vi.useRealTimers();
});

function fakeScheduler(): Scheduler & { tick(ms: number): void } {
  let now = 0; let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    clear: (t) => { timers.delete(t); },
    set: (fn, ms) => { id += 1; timers.set(id, { at: now + ms, fn }); return id; },
    tick(ms) {
      now += ms;
      for (const [k, t] of [...timers]) if (t.at <= now) { timers.delete(k); t.fn(); }
    },
  };
}

const holdRelease: HoldReleaseApi = {
  arm: async () => false, disarm: async () => undefined, isAvailable: () => false, listen: async () => () => undefined,
};

function nativeController() {
  const bound = new Set<string>();
  const calls: string[] = [];
  const api: NativeShortcutApi = {
    isAvailable: () => true,
    async register(h) { calls.push(`+${h}`); bound.add(h); },
    async unregister(h) { calls.push(`-${h}`); bound.delete(h); },
    async unregisterAll() { bound.clear(); },
  };
  const controller = createNativeShortcutController({
    api, clock: () => 0, holdRelease, onGesture: () => undefined, scheduler: fakeScheduler(),
  });
  return { bound, calls, controller };
}

describe('unbindWhileRecording', () => {
  it('local lease: unbind on begin, re-bind on end (cancel/blur/unmount paths)', async () => {
    const { bound, calls, controller } = nativeController();
    await controller.setShortcut('Shift + Space');
    const stop = unbindWhileRecording(controller, { scheduler: fakeScheduler() });
    const end = beginRecordingSuspend();
    await controller.suspendBinding(true); // flush queue
    expect(bound.size).toBe(0);
    expect(controller.activeHotkey()).toBeNull();
    end();
    await controller.suspendBinding(false);
    expect(bound.has('Shift+Space')).toBe(true);
    expect(calls).toEqual(['+Shift+Space', '-Shift+Space', '+Shift+Space']);
    stop();
  });

  it('a save during recording binds the new combo and resume does not re-bind the old one', async () => {
    const { bound, controller } = nativeController();
    await controller.setShortcut('Shift + Space');
    await controller.suspendBinding(true);
    await controller.setShortcut('Ctrl + Alt + K');
    await controller.suspendBinding(false);
    expect([...bound]).toEqual(['Control+Alt+K']);
  });

  it('re-binds when a remote lease lapses without an off event', () => {
    const s = fakeScheduler();
    const suspendBinding = vi.fn<(on: boolean) => Promise<void>>(async () => undefined);
    const now = Date.now();
    vi.useFakeTimers({ now, toFake: ['Date'] });
    const stop = unbindWhileRecording({ suspendBinding }, { scheduler: s });
    applyRemoteLease({ on: true, source: 'settings-window' });
    expect(suspendBinding).toHaveBeenLastCalledWith(true);
    vi.setSystemTime(now + LEASE_MS + 1);
    s.tick(UNBIND_RECHECK_MS);
    expect(suspendBinding).toHaveBeenLastCalledWith(false);
    stop();
  });

  it('stopping while unbound restores the binding', () => {
    const suspendBinding = vi.fn<(on: boolean) => Promise<void>>(async () => undefined);
    const stop = unbindWhileRecording({ suspendBinding }, { scheduler: fakeScheduler() });
    beginRecordingSuspend();
    stop();
    expect(suspendBinding.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });
});

describe('re-recording the current shortcut', () => {
  it('shows the normal confirmation instead of doing nothing', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('Shift + Space');
      return <ShortcutRecorder defaultValue="Ctrl + Shift + Space" onChange={(v) => { setValue(v); onChange(v); }} value={value} />;
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /^Dictation shortcut/ }));
    await user.keyboard('{Shift>}{ }{/Shift}');
    expect(onChange).toHaveBeenCalledWith('Shift + Space');
    expect(screen.getByText(successText('Shift + Space'))).toBeTruthy();
  });
});
