import { StrictMode, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { PREWARM_LAUNCH_DELAY_MS, prewarmCleanup } from '../../../src/services/cleanup/prewarm';
import { useCleanupPrewarm, type CleanupPrewarmOptions } from '../../../src/services/stt/useCleanupPrewarm';

function setup(initial: Omit<CleanupPrewarmOptions, 'prewarm'>, wrapper?: (props: { children: ReactNode }) => ReactNode) {
  const prewarm = vi.fn(() => Promise.resolve('started'));
  const hook = renderHook(
    (props: Omit<CleanupPrewarmOptions, 'prewarm'>) => useCleanupPrewarm({ ...props, prewarm }),
    { initialProps: initial, wrapper },
  );
  return { hook, prewarm };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('cleanup prewarm triggers (BUS-16 3c-2c C2)', () => {
  it('prewarms once, a little after launch, when cleanup is on', () => {
    const { prewarm } = setup({ active: true, ready: true });
    vi.advanceTimersByTime(PREWARM_LAUNCH_DELAY_MS - 1);
    expect(prewarm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prewarm).toHaveBeenCalledExactlyOnceWith('launch');
    vi.advanceTimersByTime(60_000);
    expect(prewarm).toHaveBeenCalledOnce();
  });

  it('does not prewarm at launch when cleanup is off', () => {
    const { prewarm } = setup({ active: false, ready: true });
    vi.advanceTimersByTime(60_000);
    expect(prewarm).not.toHaveBeenCalled();
  });

  it('treats settings that hydrate at boot as the launch state, not a switch-on', () => {
    const { hook, prewarm } = setup({ active: false, ready: false });
    hook.rerender({ active: true, ready: true });
    expect(prewarm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PREWARM_LAUNCH_DELAY_MS);
    expect(prewarm).toHaveBeenCalledExactlyOnceWith('launch');
  });

  it('waits for hydration before deciding anything', () => {
    const { prewarm } = setup({ active: true, ready: false });
    vi.advanceTimersByTime(60_000);
    expect(prewarm).not.toHaveBeenCalled();
  });

  it('prewarms at once on every switch-on', () => {
    const { hook, prewarm } = setup({ active: false, ready: true });
    hook.rerender({ active: true, ready: true });
    expect(prewarm).toHaveBeenCalledExactlyOnceWith('switch-on');
    hook.rerender({ active: true, ready: true });
    hook.rerender({ active: false, ready: true });
    hook.rerender({ active: true, ready: true });
    expect(prewarm.mock.calls).toEqual([['switch-on'], ['switch-on']]);
    vi.advanceTimersByTime(60_000);
    expect(prewarm).toHaveBeenCalledTimes(2);
  });

  it('switching off cancels a pending launch prewarm; switching back on prewarms once', () => {
    const { hook, prewarm } = setup({ active: true, ready: true });
    vi.advanceTimersByTime(1_000);
    hook.rerender({ active: false, ready: true });
    vi.advanceTimersByTime(PREWARM_LAUNCH_DELAY_MS);
    expect(prewarm).not.toHaveBeenCalled();
    hook.rerender({ active: true, ready: true });
    vi.advanceTimersByTime(60_000);
    expect(prewarm).toHaveBeenCalledExactlyOnceWith('switch-on');
  });

  it('fires the launch prewarm once under StrictMode', () => {
    const { prewarm } = setup({ active: true, ready: true }, StrictMode);
    vi.advanceTimersByTime(PREWARM_LAUNCH_DELAY_MS);
    expect(prewarm).toHaveBeenCalledExactlyOnceWith('launch');
  });

  it('fires one switch-on under StrictMode', () => {
    const { hook, prewarm } = setup({ active: false, ready: true }, StrictMode);
    hook.rerender({ active: true, ready: true });
    expect(prewarm).toHaveBeenCalledExactlyOnceWith('switch-on');
  });

  it('stops a pending launch prewarm on unmount, and does nothing without native', () => {
    const { hook, prewarm } = setup({ active: true, ready: true });
    hook.unmount();
    vi.advanceTimersByTime(60_000);
    expect(prewarm).not.toHaveBeenCalled();
    const browser = renderHook(() => useCleanupPrewarm({ active: true, ready: true }));
    vi.advanceTimersByTime(60_000);
    browser.unmount();
  });

  it('swallows a failed prewarm', async () => {
    const prewarm = vi.fn(() => Promise.reject(new Error('no worker')));
    renderHook(() => useCleanupPrewarm({ active: true, prewarm, ready: true }));
    await vi.advanceTimersByTimeAsync(PREWARM_LAUNCH_DELAY_MS);
    expect(prewarm).toHaveBeenCalledOnce();
  });

  it('asks native with the trigger', async () => {
    invoke.mockResolvedValueOnce('low-power');
    await expect(prewarmCleanup('launch')).resolves.toBe('low-power');
    expect(invoke).toHaveBeenCalledWith('cleanup_prewarm', { trigger: 'launch' });
  });
});
