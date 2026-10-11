// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { deliverTranscript } from '../../../src/services/delivery/deliver';
import type {
  DeliveryPlatformAdapter,
  TargetSnapshot,
} from '../../../src/services/delivery/types';

function snap(partial: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    appName: 'TextEdit',
    appPid: 42,
    capturedAt: 1,
    elementId: '42:AXTextArea:',
    elementRole: 'AXTextArea',
    insertable: true,
    kind: 'insertable',
    reason: null,
    ...partial,
  };
}

function adapter(
  overrides: Partial<DeliveryPlatformAdapter> = {},
): DeliveryPlatformAdapter {
  const intended = snap();
  return {
    clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'ours' }),
    clipboardRestore: vi.fn().mockResolvedValue(undefined),
    clipboardWrite: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(undefined),
    snapshotTarget: vi.fn().mockResolvedValue(intended),
    validateTarget: vi.fn().mockResolvedValue(intended),
    ...overrides,
  };
}

describe('deliverTranscript', () => {
  it.each(['validation', 'insert'] as const)('late %s rejection after supersession cannot trigger Copy fallback', async (stage) => {
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<never>((_, fail) => { reject = fail; });
    let current = true;
    const deferredFailure = vi.fn(() => { entered(); return gate; });
    const platform = adapter(stage === 'validation'
      ? { validateTarget: deferredFailure } : { insertText: deferredFailure });
    const pending = deliverTranscript({
      clipboardFallback: true, intended: snap(), platform, text: 'old transcript',
      isCurrent: () => current,
    });
    await started;
    current = false;
    reject(new Error('late native failure'));
    const result = await pending;
    expect(result.status).toBe('failed');
    expect(result.message).toContain('cancelled or superseded');
    expect(result.text).toBe('old transcript');
    expect(platform.validateTarget).toHaveBeenCalledOnce();
    expect(platform.insertText).toHaveBeenCalledTimes(stage === 'insert' ? 1 : 0);
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
    expect(platform.clipboardRead).not.toHaveBeenCalled();
    expect(platform.clipboardRestore).not.toHaveBeenCalled();
  });

  it.each(['complete', 'partial'])('Terminal %s dispatch is unverified, never copied or retried', async (terminalDispatch) => {
    const platform = adapter({
      insertText: vi.fn().mockResolvedValue({
        detail: 'input buffer not verified',
        terminalDispatch,
        typed: true,
        unverified: true,
      }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'café 日本語 🙂',
    });
    expect(outcome.status).toBe('unverified');
    expect(outcome.message).toContain('input not verified');
    expect(outcome.message).toContain('Inspect before retrying');
    expect(outcome.message).not.toContain('Inserted');
    expect(platform.insertText).toHaveBeenCalledTimes(1);
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
    expect(platform.clipboardRead).not.toHaveBeenCalled();
  });

  it('keeps uncertain Terminal evidence after cancellation and does not copy', async () => {
    let current = true;
    const platform = adapter({
      insertText: vi.fn().mockImplementation(async () => {
        current = false;
        return { detail: null, terminalDispatch: 'partial', typed: true, unverified: true };
      }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      isCurrent: () => current,
      platform,
      text: 'hello',
    });
    expect(outcome.status).toBe('unverified');
    expect(outcome.message).toContain('partly sent');
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
    expect(platform.insertText).toHaveBeenCalledTimes(1);
  });

  it('emits Inserted only when insert completes', async () => {
    const platform = adapter();
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'hello',
    });
    expect(outcome.status).toBe('inserted');
    expect(outcome.message).toBe('Inserted');
    expect(platform.insertText).toHaveBeenCalledWith('hello', snap());
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('reports typed web inserts as Inserted without touching the clipboard', async () => {
    const platform = adapter({
      insertText: vi.fn().mockResolvedValue({
        detail: null,
        typed: true,
        unverified: false,
      }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'hello',
    });
    expect(outcome.status).toBe('inserted');
    expect(outcome.message).toBe('Inserted');
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('unverified native insert → may have been inserted, also copied', async () => {
    const platform = adapter({
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'hello' }),
      insertText: vi.fn().mockResolvedValue({
        detail: 'typed but could not be verified via AXValue',
        typed: true,
        unverified: true,
      }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'hello',
    });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe('May have been inserted — also copied');
    expect(platform.clipboardWrite).toHaveBeenCalledWith('hello');
  });

  it('keeps the may-have-been-inserted warning when Copy fails', async () => {
    const platform = adapter({
      clipboardWrite: vi.fn().mockRejectedValue(new Error('denied')),
      insertText: vi.fn().mockResolvedValue({
        detail: null,
        typed: true,
        unverified: true,
      }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'hello',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toMatch(/^May have been inserted — Failed/);
  });

  it('keeps the warning when Copy fallback is disabled', async () => {
    const platform = adapter({
      insertText: vi.fn().mockResolvedValue({
        detail: null,
        typed: false,
        unverified: true,
      }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: false,
      intended: snap(),
      platform,
      text: 'hello',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toMatch(/^May have been inserted — Failed/);
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('empty transcript never inserts or overwrites the clipboard', async () => {
    const platform = adapter();
    for (const text of ['', '   ']) {
      const outcome = await deliverTranscript({
        clipboardFallback: true,
        intended: snap(),
        platform,
        text,
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.message).toMatch(/nothing to insert/);
    }
    expect(platform.insertText).not.toHaveBeenCalled();
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('plain insert failures keep the regular Copied message', async () => {
    const platform = adapter({
      insertText: vi.fn().mockRejectedValue(new Error('AX set failed')),
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'hello' }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'hello',
    });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toMatch(/^Copied — insert failed: AX set failed/);
  });

  it('passes non-ASCII transcripts through unchanged', async () => {
    const text = 'café 👋 你好';
    const platform = adapter();
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text,
    });
    expect(outcome.status).toBe('inserted');
    expect(platform.insertText).toHaveBeenCalledWith(text, snap());
    expect(outcome.text).toBe(text);
  });

  it('refuses secure target → Copied with truthful reason', async () => {
    const secure = snap({
      insertable: false,
      kind: 'secure',
      reason: 'secure field — insert skipped',
    });
    const platform = adapter({
      validateTarget: vi.fn().mockResolvedValue(secure),
      clipboardRead: vi.fn().mockResolvedValue({
        ok: true,
        text: 'secret dictation',
      }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'secret dictation',
    });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toMatch(/^Copied —/);
    expect(outcome.message).toMatch(/secure/);
    expect(platform.insertText).not.toHaveBeenCalled();
    expect(platform.clipboardWrite).toHaveBeenCalledWith('secret dictation');
  });

  it('wrong/changed target never inserts', async () => {
    const changed = snap({
      insertable: false,
      kind: 'changed',
      reason: 'target changed',
    });
    const platform = adapter({
      validateTarget: vi.fn().mockResolvedValue(changed),
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'x' }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'x',
    });
    expect(platform.insertText).not.toHaveBeenCalled();
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toMatch(/changed/);
  });

  it('clipboard fallback off → Failed with manual recovery', async () => {
    const closed = snap({
      insertable: false,
      kind: 'closed',
      reason: 'original app closed',
    });
    const platform = adapter({
      validateTarget: vi.fn().mockResolvedValue(closed),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: false,
      intended: snap(),
      platform,
      text: 'recover me',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toMatch(/^Failed —/);
    expect(outcome.message).toMatch(/manual Copy/i);
    expect(outcome.text).toBe('recover me');
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('insert API failure falls back to Copy when enabled', async () => {
    const platform = adapter({
      insertText: vi.fn().mockRejectedValue(new Error('AX set failed')),
      clipboardRead: vi.fn().mockResolvedValue({
        ok: true,
        text: 'fallback text',
      }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'fallback text',
    });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toMatch(/insert failed/);
  });

  it('AX selected-text failure Copies without claiming Inserted', async () => {
    const platform = adapter({
      insertText: vi.fn().mockRejectedValue(new Error('AX set AXSelectedText failed')),
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'dictation' }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'dictation',
    });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toContain('AXSelectedText failed');
    expect(platform.clipboardWrite).toHaveBeenCalledWith('dictation');
  });

  it('AX selected-text failure with Copy off fails without writing', async () => {
    const platform = adapter({
      insertText: vi.fn().mockRejectedValue(new Error('AX set AXSelectedText failed')),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: false,
      intended: snap(),
      platform,
      text: 'dictation',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toMatch(/manual Copy/i);
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('unavailable AX focus Copies without claiming the app closed', async () => {
    const platform = adapter({
      validateTarget: vi.fn().mockResolvedValue(snap({
        appPid: null,
        elementId: null,
        insertable: false,
        kind: 'unavailable',
        reason: 'Accessibility permission denied — insert skipped',
      })),
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'dictation' }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'dictation',
    });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toMatch(/Accessibility permission denied/);
    expect(outcome.message).not.toMatch(/closed|focus lost/);
    expect(platform.insertText).not.toHaveBeenCalled();
  });

  it('unavailable AX focus with Copy off reports Failed without writing', async () => {
    const platform = adapter({
      validateTarget: vi.fn().mockResolvedValue(snap({
        appPid: null,
        elementId: null,
        insertable: false,
        kind: 'unavailable',
        reason: 'Accessibility permission denied — insert skipped',
      })),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: false,
      intended: snap(),
      platform,
      text: 'dictation',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toMatch(/Accessibility permission denied/);
    expect(outcome.message).not.toMatch(/closed|focus lost/);
    expect(platform.insertText).not.toHaveBeenCalled();
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'completion AX diagnostic with fallback %s reports the actual stage/code',
    async (clipboardFallback) => {
      const platform = adapter({
        validateTarget: vi.fn().mockResolvedValue(snap({
          appPid: null,
          elementId: null,
          insertable: false,
          kind: 'unavailable',
          reason: 'Accessibility focus unavailable at delivery validation '
            + '(AX trusted=yes; AXFocusedApplication=0; '
            + 'AXFocusedUIElement=-25204)',
        })),
        clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'dictation' }),
      });
      const outcome = await deliverTranscript({
        clipboardFallback,
        intended: snap(),
        platform,
        text: 'dictation',
      });
      expect(outcome.status).toBe(clipboardFallback ? 'copied' : 'failed');
      expect(outcome.message).toContain('delivery validation');
      expect(outcome.message).toContain('AXFocusedUIElement=-25204');
      expect(outcome.message).not.toContain('closed');
      expect(platform.insertText).not.toHaveBeenCalled();
      expect(platform.clipboardWrite).toHaveBeenCalledTimes(clipboardFallback ? 1 : 0);
    },
  );

  it('clipboard write failure → Failed recoverable messaging', async () => {
    const unavailable = snap({
      insertable: false,
      kind: 'unavailable',
      reason: 'no AX',
    });
    const platform = adapter({
      validateTarget: vi.fn().mockResolvedValue(unavailable),
      clipboardWrite: vi.fn().mockRejectedValue(new Error('Clipboard unavailable')),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: snap(),
      platform,
      text: 'keep me',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toMatch(/clipboard unavailable/i);
    expect(outcome.text).toBe('keep me');
  });

  it('clipboard conflict after write → Failed (no false Copied)', async () => {
    const unavailable = snap({
      insertable: false,
      kind: 'unavailable',
      reason: 'no AX',
    });
    const platform = adapter({
      validateTarget: vi.fn().mockResolvedValue(unavailable),
      clipboardRead: vi.fn().mockResolvedValue({
        ok: true,
        text: 'user intervened',
      }),
    });
    const outcome = await deliverTranscript({
      clipboardFallback: true,
      intended: null,
      platform,
      text: 'ours',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toMatch(/changed after write/i);
    expect(outcome.restoreSkippedReason).toMatch(/changed/);
  });
});
