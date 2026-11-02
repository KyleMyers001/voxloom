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
    pasteApp: '/Applications/WezTerm.app',
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

/** `intended` is the recording-start snapshot; it defaults to the validated one. */
const run = (
  validated: TargetSnapshot,
  overrides: Partial<DeliveryPlatformAdapter> = {},
  clipboardFallback = true,
  isCurrent = () => true,
  intended: TargetSnapshot = validated,
) => {
  const platform = adapter(validated, overrides);
  return deliverTranscript({
    clipboardFallback, intended, isCurrent, platform, text: 'hello',
  }).then((outcome) => ({ outcome, platform }));
};

/** Notes, as dictation started there. */
const notes = (partial: Partial<TargetSnapshot> = {}): TargetSnapshot => ({
  appName: 'Notes',
  appPid: 11,
  capturedAt: 1,
  elementId: '11:AXTextArea:#1',
  elementRole: 'AXTextArea',
  insertable: true,
  kind: 'insertable',
  pasteApp: null,
  pasteTerminal: false,
  reason: null,
  ...partial,
});

const ghostty = (partial: Partial<TargetSnapshot> = {}) => wezterm({
  appName: 'Ghostty', appPid: 88, pasteApp: '/Applications/Ghostty.app', ...partial,
});

describe('terminal paste plan', () => {
  it('a flagged terminal pastes whatever AX says about its focus', () => {
    for (const kind of ['unsupported', 'unavailable', 'insertable'] as const) {
      const here = wezterm({ insertable: kind === 'insertable', kind });
      expect(planDelivery(here, true, here)).toMatchObject({ action: 'paste' });
    }
  });

  it('same terminal at hold start with no AX focus now still pastes', () => {
    const intended = wezterm({ kind: 'insertable', insertable: true, elementId: '77:AXTextArea:#1' });
    const now = wezterm({ kind: 'unavailable', reason: 'Accessibility focus unavailable' });
    expect(planDelivery(now, true, intended)).toMatchObject({ action: 'paste' });
  });

  it('never pastes into a secure field, a changed target or a closed app', () => {
    for (const kind of ['secure', 'changed', 'closed'] as const) {
      const here = wezterm({ kind });
      expect(planDelivery(here, true, wezterm()).action).not.toBe('paste');
      expect(planDelivery(wezterm(), true, here).action).not.toBe('paste');
    }
  });

  it('is bound to where dictation started', () => {
    // Notes at hold start, WezTerm now: the old behaviour (Copy + hint).
    expect(planDelivery(wezterm(), true, notes())).toMatchObject({ action: 'copy', terminal: true });
    // WezTerm at hold start, Ghostty now.
    expect(planDelivery(ghostty(), true, wezterm())).toMatchObject({ action: 'copy', terminal: true });
    // Same app path, another process (a second instance).
    expect(planDelivery(wezterm({ appPid: 78 }), true, wezterm())).toMatchObject({ action: 'copy' });
    // Same pid, another app (a reused pid).
    expect(planDelivery(wezterm({ pasteApp: '/Applications/Ghostty.app' }), true, wezterm()))
      .toMatchObject({ action: 'copy' });
    // No intended snapshot at all.
    expect(planDelivery(wezterm(), true)).toMatchObject({ action: 'copy' });
  });

  it('fails closed without a pid or app path at either end', () => {
    for (const lacking of [{ appPid: null }, { pasteApp: null }, { pasteApp: '' }] as const) {
      expect(planDelivery(wezterm(lacking), true, wezterm())).toMatchObject({ action: 'copy' });
      expect(planDelivery(wezterm(), true, wezterm(lacking))).toMatchObject({ action: 'copy' });
    }
  });

  it('needs the Clipboard fallback setting: off is the behaviour from before the paste route', () => {
    expect(planDelivery(wezterm(), false, wezterm())).toMatchObject({ action: 'fail', kind: 'unsupported' });
  });

  it('an unflagged or older snapshot keeps the old plans', () => {
    expect(planDelivery(wezterm({ pasteTerminal: false }), true, wezterm()))
      .toMatchObject({ action: 'copy', terminal: true });
    const older = wezterm();
    delete older.pasteTerminal;
    delete older.pasteApp;
    expect(planDelivery(older, true, older)).toMatchObject({ action: 'copy', terminal: true });
    const insertable = { insertable: true, kind: 'insertable', pasteApp: null, pasteTerminal: false } as const;
    expect(planDelivery(wezterm(insertable), true, wezterm(insertable)))
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

  it('hands native the recording-start snapshot, not the current one', async () => {
    const intended = wezterm({ kind: 'insertable', insertable: true, elementId: '77:AXTextArea:#1' });
    const now = wezterm({ kind: 'unavailable', reason: 'no focus' });
    const { platform } = await run(now, {}, true, () => true, intended);
    expect(platform.pasteText).toHaveBeenCalledWith('hello', intended);
  });

  it('Notes then WezTerm copies, as before: no paste, nothing touched but the Copy', async () => {
    const { outcome, platform } = await run(wezterm(), {}, true, () => true, notes());
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe(TERMINAL_COPY_MESSAGE);
  });

  it('WezTerm then Ghostty copies', async () => {
    const { outcome, platform } = await run(ghostty(), {}, true, () => true, wezterm());
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(outcome.status).toBe('copied');
  });

  it('a terminal with no recorded pid copies', async () => {
    const { outcome, platform } = await run(wezterm(), {}, true, () => true, wezterm({ appPid: null }));
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(outcome.status).toBe('copied');
  });

  it('Clipboard fallback off: no paste, nothing on the clipboard, text stays in History', async () => {
    const { outcome, platform } = await run(wezterm(), {}, false);
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
    expect(platform.clipboardRestore).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    expect(outcome.text).toBe('hello');
  });

  it('a successful paste is as quiet as an insert: no HUD result, ok-toned toast', async () => {
    const { outcome } = await run(wezterm());
    expect(hudResultFor(outcome)).toBeNull();
    expect(toastTone(outcome.message)).toBe('ok');
  });

  it('a clipboard that was not put back is a warn toast, not ok and not an error', async () => {
    for (const reason of [
      'clipboard changed during paste — left as-is',
      'prior clipboard could not be saved',
      'restore did not complete: pasteboard refused the saved items',
    ]) {
      const { outcome } = await run(wezterm(), {
        pasteText: vi.fn().mockResolvedValue({ clipboardRestored: false, restoreSkippedReason: reason }),
      });
      expect(toastTone(outcome.message), reason).toBe('warn');
    }
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
