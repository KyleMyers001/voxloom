// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { deliverTranscript } from '../../../src/services/delivery/deliver';
import { TERMINAL_COPY_MESSAGE, TERMINAL_PASTE_MESSAGE } from '../../../src/services/delivery/messages';
import { planDelivery } from '../../../src/services/delivery/policy';
import { toastTone } from '../../../src/components/Toast';
import { hudResultFor } from '../../../src/services/stt/dogfoodPhase';
import { InsertError } from '../../../src/services/delivery/types';
import type {
  DeliveryPlatformAdapter,
  TargetSnapshot,
} from '../../../src/services/delivery/types';

/** What WezTerm looks like to AX: a window with no usable text field. */
function wezterm(partial: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    appName: 'WezTerm',
    appPid: 77,
    capturedAt: 1,
    elementId: null,
    elementRole: null,
    insertable: false,
    kind: 'unsupported',
    knownTerminal: true,
    pasteTerminal: true,
    reason: 'unsupported or unknown AX role',
    ...partial,
  } as TargetSnapshot;
}

function adapter(
  validated: TargetSnapshot,
  overrides: Partial<DeliveryPlatformAdapter> = {},
): DeliveryPlatformAdapter {
  return {
    clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'hello' }),
    clipboardRestore: vi.fn().mockResolvedValue(undefined),
    clipboardWrite: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(undefined),
    pasteText: vi.fn().mockResolvedValue({ clipboardRestored: true, restoreSkippedReason: null }),
    snapshotTarget: vi.fn().mockResolvedValue(validated),
    validateTarget: vi.fn().mockResolvedValue(validated),
    ...overrides,
  };
}

const run = (
  validated: TargetSnapshot,
  overrides: Partial<DeliveryPlatformAdapter> = {},
  clipboardFallback = true,
  isCurrent = () => true,
) => {
  const platform = adapter(validated, overrides);
  return deliverTranscript({
    clipboardFallback, intended: validated, isCurrent, platform, text: 'hello',
  }).then((outcome) => ({ outcome, platform }));
};

describe('terminal paste plan', () => {
  it('a flagged terminal pastes whatever AX says about its focus', () => {
    for (const kind of ['unsupported', 'unavailable', 'insertable'] as const) {
      expect(planDelivery(wezterm({ insertable: kind === 'insertable', kind }), true))
        .toMatchObject({ action: 'paste' });
    }
    // Even with Copy fallback off: paste is the primary route.
    expect(planDelivery(wezterm(), false)).toMatchObject({ action: 'paste' });
  });

  it('never pastes into a secure field, a changed target or a closed app', () => {
    for (const kind of ['secure', 'changed', 'closed'] as const) {
      expect(planDelivery(wezterm({ kind }), true).action).not.toBe('paste');
    }
  });

  it('an unflagged or older snapshot keeps the old plans', () => {
    expect(planDelivery(wezterm({ pasteTerminal: false }), true))
      .toMatchObject({ action: 'copy', terminal: true });
    const older = wezterm();
    delete older.pasteTerminal;
    expect(planDelivery(older, true)).toMatchObject({ action: 'copy', terminal: true });
    expect(planDelivery(wezterm({ insertable: true, kind: 'insertable', pasteTerminal: false }), true))
      .toMatchObject({ action: 'insert' });
  });
});

describe('terminal paste delivery', () => {
  it('pastes natively, with no clipboard write from JS and no insert', async () => {
    const { outcome, platform } = await run(wezterm());
    expect(platform.pasteText).toHaveBeenCalledWith('hello', expect.objectContaining({ appName: 'WezTerm' }));
    expect(platform.insertText).not.toHaveBeenCalled();
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      clipboardRestored: true,
      message: TERMINAL_PASTE_MESSAGE,
      restoreSkippedReason: null,
      status: 'unverified',
      text: 'hello',
    });
  });

  it('is silent on the HUD and not an amber toast', async () => {
    const { outcome } = await run(wezterm());
    expect(hudResultFor(outcome)).toBeNull();
    expect(toastTone(outcome.message)).toBe('ok');
  });

  it('says so when the clipboard could not be put back', async () => {
    const { outcome } = await run(wezterm(), {
      pasteText: vi.fn().mockResolvedValue({
        clipboardRestored: false, restoreSkippedReason: 'clipboard changed during paste — left as-is',
      }),
    });
    expect(outcome.status).toBe('unverified');
    expect(outcome.clipboardRestored).toBe(false);
    expect(outcome.restoreSkippedReason).toBe('clipboard changed during paste — left as-is');
    expect(outcome.message).toBe(
      `${TERMINAL_PASTE_MESSAGE} (clipboard not restored: clipboard changed during paste — left as-is)`,
    );
  });

  it('a refusal before ⌘V copies with the terminal hint', async () => {
    const { outcome, platform } = await run(wezterm(), {
      pasteText: vi.fn().mockRejectedValue(new InsertError('Secure Keyboard Entry is on — paste skipped', false)),
    });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe(TERMINAL_COPY_MESSAGE);
    expect(outcome.detail).toBe('paste skipped: Secure Keyboard Entry is on — paste skipped');
    expect(platform.clipboardWrite).toHaveBeenCalledWith('hello');
    expect(hudResultFor(outcome)).toBe('copied');
  });

  it('a refusal with Copy fallback off is a failure, nothing copied', async () => {
    const { outcome, platform } = await run(wezterm(), {
      pasteText: vi.fn().mockRejectedValue(new InsertError('text contains control characters', false)),
    }, false);
    expect(outcome.status).toBe('failed');
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
  });

  it('a missing paste adapter falls back to Copy', async () => {
    const { outcome } = await run(wezterm(), { pasteText: undefined });
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe(TERMINAL_COPY_MESSAGE);
  });

  it('an IPC failure after dispatch may have pasted: never "press ⌘V" as if nothing happened', async () => {
    const { outcome } = await run(wezterm(), {
      pasteText: vi.fn().mockRejectedValue(new InsertError('IPC channel closed', true)),
    });
    expect(outcome.mayHaveInserted).toBe(true);
    expect(outcome.message).not.toContain('press ⌘V');
    expect(outcome.status).toBe('copied');
  });

  it('a refusal after the session was superseded fails without touching the clipboard', async () => {
    const late = await run(wezterm(), {
      pasteText: vi.fn().mockRejectedValue(new InsertError('refused', false)),
    }, true, () => false);
    expect(late.outcome.status).toBe('failed');
    expect(late.platform.clipboardWrite).not.toHaveBeenCalled();
  });
});
