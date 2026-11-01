// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { deliverTranscript } from '../../../src/services/delivery/deliver';
import { TERMINAL_COPY_MESSAGE } from '../../../src/services/delivery/messages';
import { planDelivery } from '../../../src/services/delivery/policy';
import type {
  DeliveryPlatformAdapter,
  TargetSnapshot,
} from '../../../src/services/delivery/types';

function snap(partial: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    appName: 'TextEdit',
    appPid: 42,
    capturedAt: 1,
    elementId: '42:AXTextArea:#1',
    elementRole: 'AXTextArea',
    insertable: true,
    kind: 'insertable',
    reason: null,
    ...partial,
  };
}

/** What a terminal's snapshot looks like when AX cannot insert into it. */
const terminal = (partial: Partial<TargetSnapshot> = {}) => snap({
  appName: 'kitty',
  insertable: false,
  kind: 'unsupported',
  knownTerminal: true,
  reason: 'unsupported or unknown AX role',
  ...partial,
});

function adapter(
  validated: TargetSnapshot,
  overrides: Partial<DeliveryPlatformAdapter> = {},
): DeliveryPlatformAdapter {
  return {
    clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'hello' }),
    clipboardRestore: vi.fn().mockResolvedValue(undefined),
    clipboardWrite: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(undefined),
    snapshotTarget: vi.fn().mockResolvedValue(validated),
    validateTarget: vi.fn().mockResolvedValue(validated),
    ...overrides,
  };
}

const deliver = (validated: TargetSnapshot, overrides = {}, clipboardFallback = true) =>
  deliverTranscript({
    clipboardFallback,
    intended: validated,
    platform: adapter(validated, overrides),
    text: 'hello',
  });

describe('terminal Copy hint', () => {
  it('the exact string', () => {
    expect(TERMINAL_COPY_MESSAGE).toBe('Copied, press ⌘V');
  });

  it('plan carries the terminal flag; absent or false is not a terminal', () => {
    expect(planDelivery(terminal(), true)).toMatchObject({ action: 'copy', terminal: true });
    expect(planDelivery(terminal({ knownTerminal: false }), true))
      .toMatchObject({ action: 'copy', terminal: false });
    const older = terminal();
    delete older.knownTerminal;
    expect(planDelivery(older, true)).toMatchObject({ action: 'copy', terminal: false });
  });

  it('Copy in a known terminal says "Copied, press ⌘V"; the clipboard and detail are unchanged', async () => {
    const platform = adapter(terminal());
    const outcome = await deliverTranscript({
      clipboardFallback: true, intended: terminal(), platform, text: 'hello',
    });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe('Copied, press ⌘V');
    expect(outcome.detail).toBe('unsupported or unknown AX role');
    expect(outcome.text).toBe('hello');
    expect(platform.clipboardWrite).toHaveBeenCalledWith('hello');
  });

  it('a secure field in a known terminal keeps the secure-field message', async () => {
    const secure = terminal({
      insertable: false, kind: 'secure', reason: 'secure field — insert skipped',
    });
    expect(planDelivery(secure, true)).toMatchObject({ action: 'copy', terminal: false });
    const outcome = await deliver(secure);
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe('Copied — secure field — insert skipped');
  });

  it('a terminal whose AX focus is unavailable gets the hint too', async () => {
    const outcome = await deliver(terminal({ kind: 'unavailable', reason: 'Accessibility focus unavailable' }));
    expect(outcome.message).toBe('Copied, press ⌘V');
  });

  it('Copy in any other app keeps the generic message', async () => {
    const other = snap({ insertable: false, kind: 'secure', reason: 'secure field — insert skipped' });
    const outcome = await deliver(other);
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe('Copied — secure field — insert skipped');
    const unflagged = await deliver(terminal({ knownTerminal: false }));
    expect(unflagged.message).toBe('Copied — unsupported or unknown AX role');
  });

  it('a failed native insert in a terminal copies with the hint', async () => {
    const insertable = snap({ appName: 'iTerm2', knownTerminal: true });
    const outcome = await deliver(insertable, {
      insertText: vi.fn().mockRejectedValue(new Error('AX write ignored')),
    });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe('Copied, press ⌘V');
    expect(outcome.detail).toBe('insert failed: AX write ignored');
    const elsewhere = await deliver(snap(), {
      insertText: vi.fn().mockRejectedValue(new Error('AX write ignored')),
    });
    expect(elsewhere.message).toBe('Copied — insert failed: AX write ignored');
  });

  it('other results in a terminal are unchanged', async () => {
    // Fallback off: Failed, not Copied.
    const off = await deliver(terminal(), {}, false);
    expect(off.status).toBe('failed');
    expect(off.message).not.toContain('press ⌘V');
    // Clipboard changed after our write: Failed.
    const conflict = await deliver(terminal(), {
      clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'someone else' }),
    });
    expect(conflict.status).toBe('failed');
    expect(conflict.message).not.toContain('press ⌘V');
    // Clipboard write fails: Failed.
    const noWrite = await deliver(terminal(), {
      clipboardWrite: vi.fn().mockRejectedValue(new Error('denied')),
    });
    expect(noWrite.status).toBe('failed');
    // Unverified native write: may have landed, so never "press ⌘V".
    const unverified = await deliver(snap({ knownTerminal: true }), {
      insertText: vi.fn().mockResolvedValue({ detail: 'read-back differs', typed: false, unverified: true }),
    });
    expect(unverified.message).toBe('May have been inserted — also copied');
    expect(unverified.message).not.toContain('press ⌘V');
    // Terminal dispatch (Terminal.app Unicode route): unchanged.
    const dispatched = await deliver(snap({ knownTerminal: true }), {
      insertText: vi.fn().mockResolvedValue({
        detail: 'sent', terminalDispatch: 'complete', typed: true, unverified: true,
      }),
    });
    expect(dispatched.status).toBe('unverified');
    expect(dispatched.message).toMatch(/^Text sent to Terminal/);
  });
});
