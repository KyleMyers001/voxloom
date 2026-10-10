import { describe, expect, it, vi } from 'vitest';
import {
  beginModal,
  hasOpenModal,
  subscribeModal,
} from '../../src/app/modalState';

describe('modal state', () => {
  it('tracks nested modals and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeModal(listener);
    const closeFirst = beginModal();
    const closeSecond = beginModal();
    expect(hasOpenModal()).toBe(true);
    closeSecond();
    expect(hasOpenModal()).toBe(true);
    closeFirst();
    expect(hasOpenModal()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });
});
