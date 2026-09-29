import { describe, expect, it, vi } from 'vitest';
import {
  DictationCoordinator,
} from '../../src/services/dictation/coordinator';

describe('DictationCoordinator', () => {
  it('admits two jobs and rejects a third before execution', () => {
    const coordinator = new DictationCoordinator<string>();
    expect(coordinator.reserve()).not.toBeNull();
    expect(coordinator.reserve()).not.toBeNull();
    expect(coordinator.reserve()).toBeNull();
  });

  it('runs complete jobs FIFO', async () => {
    const coordinator = new DictationCoordinator<string>();
    const first = coordinator.reserve();
    const second = coordinator.reserve();
    const order: string[] = [];
    let finishFirst: (() => void) | null = null;

    const firstResult = first?.submit(async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      order.push('first-end');
      return 'one';
    });
    const secondResult = second?.submit(async () => {
      order.push('second');
      return 'two';
    });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    expect(finishFirst).not.toBeNull();
    (finishFirst as unknown as () => void)();
    await expect(firstResult).resolves.toBe('one');
    await expect(secondResult).resolves.toBe('two');
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('cancels one request without cancelling the other', async () => {
    const coordinator = new DictationCoordinator<string>();
    const first = coordinator.reserve();
    const second = coordinator.reserve();
    const abort = vi.fn();
    const firstResult = first?.submit(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.onAbort(() => {
          abort();
          resolve();
        });
      });
      throw new DOMException('Dictation cancelled', 'AbortError');
    });
    const secondResult = second?.submit(async () => 'two');
    await Promise.resolve();
    first?.cancel();
    await expect(firstResult).rejects.toMatchObject({ name: 'AbortError' });
    await expect(secondResult).resolves.toBe('two');
    expect(abort).toHaveBeenCalledOnce();
  });
});
