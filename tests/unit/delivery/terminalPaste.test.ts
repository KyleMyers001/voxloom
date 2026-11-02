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
  PasteBinding,
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

/** The terminal in front at hold start, as native captured it. */
const WEZ_BOUND: PasteBinding = { appPid: 77, pasteApp: '/Applications/WezTerm.app' };

/**
 * `intended` is the completion-time snapshot (defaults to the validated one);
 * `pasteBinding` is the terminal captured at hold start (defaults to WezTerm).
 */
const run = (
  validated: TargetSnapshot,
  overrides: Partial<DeliveryPlatformAdapter> = {},
  clipboardFallback = true,
  isCurrent = () => true,
  intended: TargetSnapshot = validated,
  pasteBinding: PasteBinding | null = WEZ_BOUND,
) => {
  const platform = adapter(validated, overrides);
  return deliverTranscript({
    clipboardFallback, intended, isCurrent, pasteBinding, platform, text: 'hello',
  }).then((outcome) => ({ outcome, platform }));
};

const ghostty = (partial: Partial<TargetSnapshot> = {}) => wezterm({
  appName: 'Ghostty', appPid: 88, pasteApp: '/Applications/Ghostty.app', ...partial,
});

describe('terminal paste plan', () => {
  it('a flagged terminal pastes whatever AX says about its focus', () => {
    for (const kind of ['unsupported', 'unavailable', 'insertable'] as const) {
      const here = wezterm({ insertable: kind === 'insertable', kind });
      expect(planDelivery(here, true, here, WEZ_BOUND)).toMatchObject({ action: 'paste', bound: WEZ_BOUND });
    }
  });

  it('same terminal at hold start with no AX focus now still pastes', () => {
    const intended = wezterm({ kind: 'insertable', insertable: true, elementId: '77:AXTextArea:#1' });
    const now = wezterm({ kind: 'unavailable', reason: 'Accessibility focus unavailable' });
    expect(planDelivery(now, true, intended, WEZ_BOUND)).toMatchObject({ action: 'paste' });
  });

  it('never pastes into a secure field, a changed target or a closed app', () => {
    for (const kind of ['secure', 'changed', 'closed'] as const) {
      const here = wezterm({ kind });
      expect(planDelivery(here, true, wezterm(), WEZ_BOUND).action).not.toBe('paste');
      expect(planDelivery(wezterm(), true, here, WEZ_BOUND).action).not.toBe('paste');
    }
  });

  it('is bound to the terminal that was in front when dictation started', () => {
    // Notes at hold start (no binding), WezTerm at delivery: the old behaviour (Copy + hint).
    expect(planDelivery(wezterm(), true, wezterm(), null)).toMatchObject({ action: 'copy', terminal: true });
    expect(planDelivery(wezterm(), true, wezterm())).toMatchObject({ action: 'copy', terminal: true });
    // WezTerm at hold start, Ghostty at delivery (completion and validation).
    expect(planDelivery(ghostty(), true, ghostty(), WEZ_BOUND)).toMatchObject({ action: 'copy', terminal: true });
    // Switched away during transcription and back is not enough if it is another process.
    expect(planDelivery(wezterm(), true, wezterm(), { ...WEZ_BOUND, appPid: 78 })).toMatchObject({ action: 'copy' });
    // Same pid, another app (a reused pid).
    expect(planDelivery(wezterm(), true, wezterm(), { ...WEZ_BOUND, pasteApp: '/Applications/Ghostty.app' }))
      .toMatchObject({ action: 'copy' });
    // The completion target and the delivery target must agree too.
    expect(planDelivery(ghostty(), true, wezterm(), WEZ_BOUND)).toMatchObject({ action: 'copy' });
    // No completion snapshot at all.
    expect(planDelivery(wezterm(), true, undefined, WEZ_BOUND)).toMatchObject({ action: 'copy' });
  });

  it('fails closed without a pid or app path at any end', () => {
    for (const lacking of [{ appPid: null }, { pasteApp: null }, { pasteApp: '' }] as const) {
      expect(planDelivery(wezterm(lacking), true, wezterm(), WEZ_BOUND)).toMatchObject({ action: 'copy' });
      expect(planDelivery(wezterm(), true, wezterm(lacking), WEZ_BOUND)).toMatchObject({ action: 'copy' });
    }
    expect(planDelivery(wezterm(), true, wezterm(), { appPid: 77, pasteApp: '' })).toMatchObject({ action: 'copy' });
  });

  it('needs the Clipboard fallback setting: off is the behaviour from before the paste route', () => {
    expect(planDelivery(wezterm(), false, wezterm(), WEZ_BOUND)).toMatchObject({ action: 'fail', kind: 'unsupported' });
  });

  it('an unflagged or older snapshot keeps the old plans', () => {
    expect(planDelivery(wezterm({ pasteTerminal: false }), true, wezterm(), WEZ_BOUND))
      .toMatchObject({ action: 'copy', terminal: true });
    const older = wezterm();
    delete older.pasteTerminal;
    delete older.pasteApp;
    expect(planDelivery(older, true, older, WEZ_BOUND)).toMatchObject({ action: 'copy', terminal: true });
    const insertable = { insertable: true, kind: 'insertable', pasteApp: null, pasteTerminal: false } as const;
    expect(planDelivery(wezterm(insertable), true, wezterm(insertable), WEZ_BOUND))
      .toMatchObject({ action: 'insert' });
  });
});

describe('terminal paste delivery', () => {
  it('pastes natively, with no clipboard write from JS and no insert', async () => {
    const { outcome, platform } = await run(wezterm());
    expect(platform.pasteText).toHaveBeenCalledWith('hello', WEZ_BOUND);
    expect(platform.insertText).not.toHaveBeenCalled();
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      clipboardRestored: true,
      message: '',
      restoreSkippedReason: null,
      status: 'unverified',
      text: 'hello',
    });
  });

  it('hands native the hold-start terminal, not whatever is in front now', async () => {
    const intended = wezterm({ kind: 'insertable', insertable: true, elementId: '77:AXTextArea:#1' });
    const now = wezterm({ kind: 'unavailable', reason: 'no focus' });
    const { platform } = await run(now, {}, true, () => true, intended);
    expect(platform.pasteText).toHaveBeenCalledWith('hello', WEZ_BOUND);
  });

  it('Notes at hold start then WezTerm at delivery copies, as before: no paste, only the Copy', async () => {
    // Notes is no paste terminal, so nothing was captured at hold start.
    const { outcome, platform } = await run(wezterm(), {}, true, () => true, wezterm(), null);
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe(TERMINAL_COPY_MESSAGE);
  });

  it('WezTerm at hold start then Ghostty at delivery copies', async () => {
    const { outcome, platform } = await run(ghostty(), {}, true, () => true, ghostty());
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(outcome.status).toBe('copied');
  });

  it('a hold-start terminal with no pid copies', async () => {
    const { outcome, platform } = await run(wezterm(), {}, true, () => true, wezterm(), { ...WEZ_BOUND, appPid: null as unknown as number });
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

  it('a clean paste is silent: empty message (no status line, no toast), no HUD result, Unverified in History', async () => {
    const { outcome } = await run(wezterm());
    expect(outcome.message).toBe('');
    expect(hudResultFor(outcome)).toBeNull();
    expect(outcome.status).toBe('unverified');
    expect(outcome.detail).toContain('Pasted with ⌘V');
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
