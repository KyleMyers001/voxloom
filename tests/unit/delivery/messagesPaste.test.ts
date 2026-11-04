// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { deliverTranscript } from '../../../src/services/delivery/deliver';
import { TERMINAL_COPY_MESSAGE, TERMINAL_PASTE_MESSAGE } from '../../../src/services/delivery/messages';
import { planDelivery } from '../../../src/services/delivery/policy';
import { toastTone } from '../../../src/components/Toast';
import { hudResultFor } from '../../../src/services/stt/dogfoodPhase';
import type {
  DeliveryPlatformAdapter,
  PasteBinding,
  TargetSnapshot,
} from '../../../src/services/delivery/types';

const MESSAGES_APP = '/System/Applications/Messages.app';

/** Messages as native flags it: its composer gives AX no value to write to. */
function messages(partial: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    appName: 'Messages',
    appPid: 55,
    capturedAt: 1,
    elementId: null,
    elementRole: null,
    insertable: false,
    kind: 'unsupported',
    knownTerminal: true,
    pasteApp: MESSAGES_APP,
    pasteTerminal: true,
    reason: 'AXValue unreadable before insert — insert skipped',
    ...partial,
  } as TargetSnapshot;
}

/** Notes: not on the paste route, so native flags nothing. */
function notes(partial: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    appName: 'Notes',
    appPid: 12,
    capturedAt: 1,
    elementId: '12:AXTextArea:#1',
    elementRole: 'AXTextArea',
    insertable: true,
    kind: 'insertable',
    reason: null,
    ...partial,
  } as TargetSnapshot;
}

const BOUND: PasteBinding = { appPid: 55, pasteApp: MESSAGES_APP };

function run(
  validated: TargetSnapshot,
  overrides: Partial<DeliveryPlatformAdapter> = {},
  clipboardFallback = true,
  pasteBinding: PasteBinding | null = BOUND,
) {
  const platform: DeliveryPlatformAdapter = {
    clipboardRead: vi.fn().mockResolvedValue({ ok: true, text: 'hello' }),
    clipboardRestore: vi.fn().mockResolvedValue(undefined),
    clipboardWrite: vi.fn().mockResolvedValue(undefined),
    insertText: vi.fn().mockResolvedValue(undefined),
    pasteText: vi.fn().mockResolvedValue({ clipboardRestored: true, restoreSkippedReason: null }),
    snapshotTarget: vi.fn().mockResolvedValue(validated),
    validateTarget: vi.fn().mockResolvedValue(validated),
    ...overrides,
  };
  return deliverTranscript({
    clipboardFallback, intended: validated, isCurrent: () => true, pasteBinding, platform, text: 'hello',
  }).then((outcome) => ({ outcome, platform }));
}

describe('Messages on the paste route', () => {
  it('plans a paste for the Messages binding, whatever AX says about the composer', () => {
    for (const kind of ['unsupported', 'unavailable'] as const) {
      const here = messages({ kind });
      expect(planDelivery(here, true, here, BOUND)).toMatchObject({ action: 'paste', bound: BOUND });
    }
  });

  it('pastes natively and records Unverified; a clean paste is silent', async () => {
    const { outcome, platform } = await run(messages());
    expect(platform.pasteText).toHaveBeenCalledWith('hello', BOUND);
    expect(platform.insertText).not.toHaveBeenCalled();
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ clipboardRestored: true, message: '', status: 'unverified' });
    expect(hudResultFor(outcome)).toBeNull();
    expect(outcome.detail).toBe('Pasted with ⌘V through the clipboard; input not verified');
  });

  it('copies with the hint when Messages was not in front at hold start', async () => {
    const { outcome, platform } = await run(messages(), {}, true, null);
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(outcome.status).toBe('copied');
    expect(outcome.message).toBe(TERMINAL_COPY_MESSAGE);
  });

  it('copies when another app or process is in front at delivery', async () => {
    expect(planDelivery(notes(), true, messages(), BOUND).action).toBe('insert');
    expect(planDelivery(messages({ appPid: 56 }), true, messages(), BOUND).action).toBe('copy');
    expect(planDelivery(messages(), true, messages(), { ...BOUND, pasteApp: '/Applications/WezTerm.app' }).action)
      .toBe('copy');
  });

  it('Clipboard fallback off: no paste and nothing on the clipboard', async () => {
    const { outcome, platform } = await run(messages(), {}, false);
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(platform.clipboardWrite).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
  });

  it('a clipboard that was not put back is a neutral warn toast', async () => {
    const { outcome } = await run(messages(), {
      pasteText: vi.fn().mockResolvedValue({
        clipboardRestored: false, restoreSkippedReason: 'clipboard changed during paste — left as-is',
      }),
    });
    expect(outcome.status).toBe('unverified');
    expect(outcome.message).toBe(
      `${TERMINAL_PASTE_MESSAGE} (clipboard not restored: clipboard changed during paste — left as-is)`,
    );
    expect(outcome.message).not.toMatch(/terminal/i);
    expect(toastTone(outcome.message)).toBe('warn');
  });

  it('apps off the route are unchanged: Notes inserts, never pastes', async () => {
    const { outcome, platform } = await run(notes(), {}, true, null);
    expect(platform.pasteText).not.toHaveBeenCalled();
    expect(platform.insertText).toHaveBeenCalled();
    expect(outcome.status).toBe('inserted');
  });
});
