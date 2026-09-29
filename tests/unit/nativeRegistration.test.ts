import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../../src/services/contracts';
import {
  createNativeShortcutController,
  type NativeShortcutApi,
} from '../../src/services/shortcut/nativeRegistration';
import type { HoldReleaseApi } from '../../src/services/shortcut/holdReleaseBridge';

function makeScheduler(): Scheduler {
  return {
    clear: () => undefined,
    set: () => 1,
  };
}

function makeHoldRelease(): HoldReleaseApi {
  return {
    arm: async () => false,
    disarm: async () => undefined,
    isAvailable: () => false,
    listen: async () => () => undefined,
  };
}

function makeApi(options?: {
  /** Simulate OS rejecting a second register of an already-bound hotkey. */
  rejectDuplicate?: boolean;
}): {
  api: NativeShortcutApi;
  registerCalls: string[];
  unregisterCalls: string[];
} {
  const registerCalls: string[] = [];
  const unregisterCalls: string[] = [];
  const bound = new Set<string>();
  const rejectDuplicate = options?.rejectDuplicate ?? true;
  const api: NativeShortcutApi = {
    isAvailable: () => true,
    async register(hotkey) {
      registerCalls.push(hotkey);
      if (rejectDuplicate && bound.has(hotkey)) {
        throw new Error(`RegisterEventHotKey failed for ${hotkey}`);
      }
      bound.add(hotkey);
    },
    async unregister(hotkey) {
      unregisterCalls.push(hotkey);
      bound.delete(hotkey);
    },
    async unregisterAll() {
      bound.clear();
    },
  };
  return { api, registerCalls, unregisterCalls };
}

describe('createNativeShortcutController setShortcut', () => {
  it('concurrent/duplicate setShortcut same combo does not fail/toast/unbind', async () => {
    const { api, registerCalls, unregisterCalls } = makeApi();
    const onRegisterFailure = vi.fn();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdRelease: makeHoldRelease(),
      onGesture: () => undefined,
      onRegisterFailure,
      scheduler: makeScheduler(),
    });

    const combo = 'Ctrl + Shift + F';
    // Boot race: mount effect + Settings effect fire in parallel.
    const [a, b] = await Promise.all([
      controller.setShortcut(combo),
      controller.setShortcut(combo),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.active).toBe('Control+Shift+F');
      expect(b.active).toBe('Control+Shift+F');
    }
    expect(controller.activeHotkey()).toBe('Control+Shift+F');
    expect(onRegisterFailure).not.toHaveBeenCalled();
    // One real OS register; duplicate is a same-combo no-op (no unregister).
    expect(registerCalls).toEqual(['Control+Shift+F']);
    expect(unregisterCalls).toEqual([]);

    await controller.dispose();
  });

  it('still reports conflict when a different combo fails to bind', async () => {
    const registerCalls: string[] = [];
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(hotkey) {
        registerCalls.push(hotkey);
        if (hotkey === 'Control+Space') {
          throw new Error('already registered');
        }
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const onRegisterFailure = vi.fn();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdRelease: makeHoldRelease(),
      onGesture: () => undefined,
      onRegisterFailure,
      scheduler: makeScheduler(),
    });

    const first = await controller.setShortcut('Ctrl + Shift + Space');
    expect(first.ok).toBe(true);

    const second = await controller.setShortcut('Ctrl + Space');
    expect(second.ok).toBe(false);
    expect(controller.activeHotkey()).toBe('Control+Shift+Space');
    expect(onRegisterFailure).toHaveBeenCalledTimes(1);
    expect(onRegisterFailure.mock.calls[0]![0]).toContain('Kept prior shortcut');

    await controller.dispose();
  });
});

describe('createNativeShortcutController focus-safe hold', () => {
  function makeTrackingScheduler() {
    const callbacks = new Map<number, () => void>();
    let timer = 0;
    const scheduler: Scheduler = {
      clear: (id) => {
        callbacks.delete(id);
      },
      set: (callback) => {
        timer += 1;
        callbacks.set(timer, callback);
        return timer;
      },
    };
    const flush = (id: number) => {
      const cb = callbacks.get(id);
      if (cb) {
        callbacks.delete(id);
        cb();
      }
    };
    return { flush, scheduler };
  }

  it('ignores OS Released only during post-arm grace; watch can finish', async () => {
    let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
    let onHoldRelease: (() => void) | null = null;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => true,
      disarm: async () => undefined,
      listen: async (cb) => {
        onHoldRelease = cb;
        return () => undefined;
      },
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      carbonReleaseGraceMs: 50,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut('Ctrl + Shift + F');
    // Allow listen() microtask to attach.
    await Promise.resolve();
    expect(onEdge).not.toBeNull();

    onEdge!('pressed');
    flush(1); // hold-start → arms monitor + grace timer (id 2)
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(['hold-start']);

    // Spurious Carbon Released during grace must not finish.
    onEdge!('released');
    expect(gestures).toEqual(['hold-start']);

    // Real chord break via hold-release watch (primary).
    onHoldRelease!();
    expect(gestures).toEqual(['hold-start', 'hold-finish']);

    await controller.dispose();
  });

  it('after grace, Carbon Released finishes even when monitoring was true', async () => {
    let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => true,
      disarm: async () => undefined,
      // Dead watch: never emits — Carbon backup must finish.
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      carbonReleaseGraceMs: 50,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut('Ctrl + Shift + F');
    await Promise.resolve();

    onEdge!('pressed');
    flush(1); // hold-start → arm + grace timer id 2
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(['hold-start']);

    // Still in grace — ignored.
    onEdge!('released');
    expect(gestures).toEqual(['hold-start']);

    flush(2); // grace ends
    // Backup finish even though holdWatchMonitoring is still true.
    onEdge!('released');
    expect(gestures).toEqual(['hold-start', 'hold-finish']);

    await controller.dispose();
  });

  it('still finishes via OS Released when hold monitor is not active', async () => {
    let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => false,
      arm: async () => false,
      disarm: async () => undefined,
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut('Ctrl + Shift + F');
    onEdge!('pressed');
    flush(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(['hold-start']);

    onEdge!('released');
    expect(gestures).toEqual(['hold-start', 'hold-finish']);

    await controller.dispose();
  });

  it('setContext with the same value does not cancel an active hold', async () => {
    let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
    let disarmCalls = 0;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => true,
      disarm: async () => {
        disarmCalls += 1;
      },
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut('Ctrl + Shift + F');
    onEdge!('pressed');
    flush(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(['hold-start']);
    const disarmsAfterArm = disarmCalls;

    // Re-assert product context (modal subscribe / boot) must be a no-op.
    controller.setContext('product');
    expect(disarmCalls).toBe(disarmsAfterArm);
    expect(gestures).toEqual(['hold-start']);

    // Context null (modal) still resets.
    controller.setContext(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(disarmCalls).toBeGreaterThan(disarmsAfterArm);
    gestures.length = 0;
    onEdge!('released');
    expect(gestures).toEqual([]);

    await controller.dispose();
  });

  it('sync monitoring flag ignores OS Released during grace before arm() resolves', async () => {
    let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
    let resolveArm: ((v: boolean) => void) | null = null;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: () =>
        new Promise<boolean>((resolve) => {
          resolveArm = resolve;
        }),
      disarm: async () => undefined,
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      carbonReleaseGraceMs: 50,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut('Ctrl + Shift + F');
    onEdge!('pressed');
    flush(1); // hold-start → arms with sync monitoring=true + grace
    expect(gestures).toEqual(['hold-start']);
    // Hold-watch arm is queued; flush microtasks so arm() starts.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveArm).not.toBeNull();

    // Carbon Released-after-arm during grace must not finish.
    onEdge!('released');
    expect(gestures).toEqual(['hold-start']);

    resolveArm!(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(['hold-start']);

    await controller.dispose();
  });

  it('flushes suppressed OS Released when arm declines monitoring', async () => {
    let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
    let resolveArm: ((v: boolean) => void) | null = null;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: () =>
        new Promise<boolean>((resolve) => {
          resolveArm = resolve;
        }),
      disarm: async () => undefined,
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      carbonReleaseGraceMs: 50,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    await controller.setShortcut('Ctrl + Shift + F');
    onEdge!('pressed');
    flush(1);
    // Optimistic monitoring is sync; arm() itself is queued; grace active.
    await Promise.resolve();
    await Promise.resolve();
    onEdge!('released'); // suppressed during post-arm grace
    expect(gestures).toEqual(['hold-start']);

    resolveArm!(false); // non-Mac / declined → flush suppressed OS Released
    await Promise.resolve();
    await Promise.resolve();
    expect(gestures).toEqual(['hold-start', 'hold-finish']);

    await controller.dispose();
  });


  it('two sequential holds both finish; late disarm cannot kill next watch', async () => {
    let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
    let onHoldRelease: (() => void) | null = null;
    let armCount = 0;
    let pendingDisarm: Promise<void> | null = null;
    let resolveHold1Disarm: (() => void) | null = null;
    let slowDisarmArmed = false;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => {
        armCount += 1;
        return true;
      },
      disarm: async () => {
        if (!slowDisarmArmed) return;
        slowDisarmArmed = false;
        pendingDisarm = new Promise<void>((resolve) => {
          resolveHold1Disarm = resolve;
        });
        await pendingDisarm;
      },
      listen: async (cb) => {
        onHoldRelease = cb;
        return () => undefined;
      },
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      carbonReleaseGraceMs: 50,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    const drain = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };

    await controller.setShortcut('Ctrl + Shift + F');
    await drain();

    // Hold 1 — timer ids: hold(1), grace(2)
    onEdge!('pressed');
    flush(1);
    await drain();
    expect(gestures).toEqual(['hold-start']);
    expect(armCount).toBe(1);

    // Next finish disarm should hang until we resolve.
    slowDisarmArmed = true;
    onHoldRelease!();
    expect(gestures).toEqual(['hold-start', 'hold-finish']);
    await drain();
    expect(resolveHold1Disarm).not.toBeNull();

    // Hold 2 starts while hold-1 disarm IPC is still pending.
    // hold timer id 3, grace id 4
    gestures.length = 0;
    onEdge!('pressed');
    flush(3);
    expect(gestures).toEqual(['hold-start']);
    // Arm queued behind slow disarm — not finished yet.
    expect(armCount).toBe(1);

    resolveHold1Disarm!();
    await drain();
    expect(armCount).toBe(2);

    // During grace: Carbon Released still ignored.
    onEdge!('released');
    expect(gestures).toEqual(['hold-start']);

    onHoldRelease!();
    expect(gestures).toEqual(['hold-start', 'hold-finish']);

    await controller.dispose();
  });

  it('two sequential hold cycles both finish via Carbon backup after grace', async () => {
    let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
    let armCount = 0;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    // Dead watch both sessions — Carbon after grace is the only finish path.
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => {
        armCount += 1;
        return true;
      },
      disarm: async () => undefined,
      listen: async () => () => undefined,
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    const controller = createNativeShortcutController({
      api,
      carbonReleaseGraceMs: 50,
      clock: () => 0,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    const drain = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };

    await controller.setShortcut('Ctrl + Shift + F');
    await drain();

    for (let cycle = 1; cycle <= 2; cycle += 1) {
      gestures.length = 0;
      // Each cycle: hold timer then grace timer (2 timers per cycle).
      const holdTimer = (cycle - 1) * 2 + 1;
      const graceTimer = holdTimer + 1;
      onEdge!('pressed');
      flush(holdTimer);
      await drain();
      expect(gestures).toEqual(['hold-start']);
      expect(armCount).toBe(cycle);

      onEdge!('released'); // still in grace
      expect(gestures).toEqual(['hold-start']);

      flush(graceTimer);
      onEdge!('released'); // backup finish
      expect(gestures).toEqual(['hold-start', 'hold-finish']);
      await drain();
    }

    await controller.dispose();
  });

  it('fully disarms monitoring so a second hold re-arms cleanly', async () => {
    let onEdge: ((edge: 'pressed' | 'released') => void) | null = null;
    let onHoldRelease: (() => void) | null = null;
    let armed = false;
    const api: NativeShortcutApi = {
      isAvailable: () => true,
      async register(_hotkey, edge) {
        onEdge = edge;
      },
      async unregister() {},
      async unregisterAll() {},
    };
    const holdRelease: HoldReleaseApi = {
      isAvailable: () => true,
      arm: async () => {
        armed = true;
        return true;
      },
      disarm: async () => {
        armed = false;
      },
      listen: async (cb) => {
        onHoldRelease = cb;
        return () => undefined;
      },
    };
    const gestures: string[] = [];
    const { flush, scheduler } = makeTrackingScheduler();
    let now = 0;
    const controller = createNativeShortcutController({
      api,
      carbonReleaseGraceMs: 50,
      clock: () => now,
      holdMs: 10,
      holdRelease,
      onGesture: (g) => gestures.push(g),
      scheduler,
    });

    const drain = async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };

    await controller.setShortcut('Ctrl + Shift + F');
    await drain();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      gestures.length = 0;
      now += 1000;
      // Each cycle schedules hold timer then grace timer.
      const holdTimer = (cycle - 1) * 2 + 1;
      onEdge!('pressed');
      flush(holdTimer);
      await drain();
      expect(gestures).toEqual(['hold-start']);
      expect(armed).toBe(true);
      onHoldRelease!();
      expect(gestures).toEqual(['hold-start', 'hold-finish']);
      await drain();
      expect(armed).toBe(false);
    }

    await controller.dispose();
  });
});
