// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  restoreAfterPaste,
  withRestoreHonesty,
} from '../../../src/services/delivery/deliver';
import type {
  DeliveryOutcome,
  DeliveryPlatformAdapter,
} from '../../../src/services/delivery/types';

function platform(
  overrides: Partial<DeliveryPlatformAdapter> = {},
): DeliveryPlatformAdapter {
  return {
    clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'ours' }),
    clipboardRestore: vi.fn().mockResolvedValue(undefined),
    clipboardWrite: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(undefined),
    snapshotTarget: vi.fn(),
    validateTarget: vi.fn(),
    ...overrides,
  };
}

describe('restoreAfterPaste', () => {
  it('restores prior when safe', async () => {
    const p = platform();
    const result = await restoreAfterPaste({
      ourText: 'ours',
      platform: p,
      priorOk: true,
      priorText: 'prior',
      writeCompleted: true,
    });
    expect(result.restored).toBe(true);
    expect(p.clipboardRestore).toHaveBeenCalledWith('prior');
  });

  it('skips restore on intervening copy evidence', async () => {
    const p = platform({
      clipboardRead: vi.fn().mockResolvedValue({
        ok: true,
        text: 'someone else',
      }),
    });
    const result = await restoreAfterPaste({
      ourText: 'ours',
      platform: p,
      priorOk: true,
      priorText: 'prior',
      writeCompleted: true,
    });
    expect(result.restored).toBe(false);
    expect(result.skipReason).toMatch(/changed/);
    expect(p.clipboardRestore).not.toHaveBeenCalled();
  });
});

describe('withRestoreHonesty', () => {
  it('appends skip reason to Inserted message', () => {
    const base: DeliveryOutcome = {
      clipboardRestored: false,
      detail: null,
      message: 'Inserted',
      restoreSkippedReason: null,
      status: 'inserted',
      text: 'hi',
      writeCommitted: true,
      writeStarted: true,
    };
    const next = withRestoreHonesty(base, false, 'no prior clipboard snapshot');
    expect(next.message).toMatch(/clipboard not restored/);
    expect(next.clipboardRestored).toBe(false);
  });
});
