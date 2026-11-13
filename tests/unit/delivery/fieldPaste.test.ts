// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { deliverTranscript } from '../../../src/services/delivery/deliver';
import { FIELD_PASTE_UNVERIFIED_MESSAGE } from '../../../src/services/delivery/messages';
import type {
  DeliveryPlatformAdapter,
  InsertReport,
  TargetSnapshot,
} from '../../../src/services/delivery/types';

/** BUS-223: the native ⌘V fallback for fields AX refuses (Word, Mail, ...). */
const word: TargetSnapshot = {
  appName: 'Microsoft Word',
  appPid: 42,
  capturedAt: 1,
  elementId: '42:AXTextArea:#1',
  elementRole: 'AXTextArea',
  insertable: true,
  kind: 'insertable',
  reason: null,
};

function adapter(report: InsertReport | void): DeliveryPlatformAdapter {
  return {
    clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'user clipboard' }),
    clipboardRestore: vi.fn().mockResolvedValue(undefined),
    clipboardWrite: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(report),
    snapshotTarget: vi.fn().mockResolvedValue(word),
    validateTarget: vi.fn().mockResolvedValue(word),
  };
}

const restored = { clipboardRestored: true, restoreSkippedReason: null };

function deliver(platform: DeliveryPlatformAdapter, clipboardFallback = true) {
  return deliverTranscript({ clipboardFallback, intended: word, platform, text: 'hello' });
}

describe('native ⌘V field fallback', () => {
  it('asks native for the fallback only when Clipboard fallback is on', async () => {
    for (const clipboardFallback of [true, false]) {
      const platform = adapter(undefined);
      await deliver(platform, clipboardFallback);
      expect(platform.insertText).toHaveBeenCalledWith('hello', word, { pasteFallback: clipboardFallback });
    }
  });

  it('a paste proven by read-back is Inserted and never copies', async () => {
    const platform = adapter({ detail: 'pasted', paste: restored, typed: false, unverified: false });
    const outcome = await deliver(platform);
    expect(outcome.status).toBe('inserted');
    expect(outcome.message).toBe('Inserted');
    expect(outcome.clipboardRestored).toBe(true);
    expect(outcome.mayHaveInserted).toBeUndefined();
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('an unproven paste says it may have been inserted and leaves the restored clipboard alone', async () => {
    const platform = adapter({ detail: 'pasted; not confirmed', paste: restored, typed: false, unverified: true });
    const outcome = await deliver(platform);
    expect(outcome.status).toBe('unverified');
    expect(outcome.mayHaveInserted).toBe(true);
    expect(outcome.message).toBe(FIELD_PASTE_UNVERIFIED_MESSAGE);
    expect(outcome.message).toMatch(/^May have been inserted/);
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('a clipboard that was not restored is reported either way', async () => {
    const paste = { clipboardRestored: false, restoreSkippedReason: 'clipboard changed during paste — left as-is' };
    for (const unverified of [false, true]) {
      const outcome = await deliver(adapter({ detail: null, paste, typed: false, unverified }));
      expect(outcome.clipboardRestored).toBe(false);
      expect(outcome.restoreSkippedReason).toBe(paste.restoreSkippedReason);
      expect(outcome.message).toContain('clipboard not restored: clipboard changed during paste');
    }
  });

  it('a native refusal (nothing pasted) still copies with its reason', async () => {
    const platform = adapter(undefined);
    platform.clipboardRead = vi.fn().mockResolvedValue({ ok: true, text: 'hello' });
    platform.insertText = vi.fn().mockRejectedValue(
      new Error('role outside the AX insert allowlist — insert skipped; ⌘V fallback skipped: Secure Keyboard Entry is on — paste skipped'),
    );
    const outcome = await deliver(platform);
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toContain('Secure Keyboard Entry is on');
    expect(platform.clipboardWrite).toHaveBeenCalledWith('hello');
  });
});
