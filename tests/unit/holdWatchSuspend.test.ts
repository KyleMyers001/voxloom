// BUS-47: a hold-start while a recorder records must not arm the hold-release watch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../../src/services/contracts';
import type { HoldReleaseApi } from '../../src/services/shortcut/holdReleaseBridge';
import { createNativeShortcutController, type NativeShortcutApi } from '../../src/services/shortcut/nativeRegistration';
import { beginRecordingSuspend, resetRecordingSuspend } from '../../src/services/shortcut/recordingSuspend';

afterEach(() => resetRecordingSuspend());

function setup() {
  let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
  const api: NativeShortcutApi = {
    isAvailable: () => true,
    async register(_hotkey, edge) { onEdge = edge; },
    async unregister() {},
    async unregisterAll() {},
  };
  const arm = vi.fn(async () => true);
  const holdRelease: HoldReleaseApi = {
    arm, disarm: async () => undefined, isAvailable: () => true, listen: async () => () => undefined,
  };
  const callbacks = new Map<number, () => void>();
  let timer = 0;
  const scheduler: Scheduler = {
    clear: (id) => { callbacks.delete(id); },
    set: (cb) => { timer += 1; callbacks.set(timer, cb); return timer; },
  };
  const flushAll = () => { for (const [id, cb] of [...callbacks]) { callbacks.delete(id); cb(); } };
  const controller = createNativeShortcutController({
    api, clock: () => 0, holdMs: 10, holdRelease, onGesture: () => undefined, scheduler,
  });
  return { arm, controller, edge: (e: 'pressed' | 'released') => onEdge!(e), flushAll };
}

describe('hold-release watch while recording is suspended', () => {
  it('never calls holdRelease.arm while suspended', async () => {
    const { arm, controller, edge, flushAll } = setup();
    await controller.setShortcut('Ctrl + Shift + F');
    await Promise.resolve();
    const end = beginRecordingSuspend();
    edge('pressed');
    flushAll();
    await Promise.resolve();
    edge('released');
    expect(arm).not.toHaveBeenCalled();
    end();
    edge('pressed');
    flushAll();
    await Promise.resolve();
    expect(arm).toHaveBeenCalledTimes(1);
  });
});
