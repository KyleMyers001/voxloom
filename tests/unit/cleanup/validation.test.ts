import { describe, expect, it } from 'vitest';
import {
  validateCleanupOutput,
} from '../../../src/services/cleanup/validation';

describe('validateCleanupOutput', () => {
  it('accepts conservative output', () => {
    expect(validateCleanupOutput(
      'send Q3 to https://example.com on 10/4',
      'Send Q3 to https://example.com on 10/4.',
    )).toBe('Send Q3 to https://example.com on 10/4.');
  });

  it.each([
    ['', 'blank'],
    ['<think>secret</think> Text', 'reasoning'],
    ['Changed 11 and removed the URL', 'protected content'],
  ])('rejects invalid output: %s (%s)', (candidate) => {
    expect(validateCleanupOutput(
      'Keep 10 and https://example.com',
      candidate,
    )).toBeNull();
  });
});
