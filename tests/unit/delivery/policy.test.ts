// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  mayInsert,
  planDelivery,
  shouldRestoreClipboard,
  unavailableSnapshot,
} from '../../../src/services/delivery/policy';
import type { TargetSnapshot } from '../../../src/services/delivery/types';

function snap(partial: Partial<TargetSnapshot>): TargetSnapshot {
  return {
    appName: 'Notes',
    appPid: 100,
    capturedAt: 1,
    elementId: '100:AXTextArea:',
    elementRole: 'AXTextArea',
    insertable: true,
    kind: 'insertable',
    reason: null,
    ...partial,
  };
}

describe('mayInsert / planDelivery', () => {
  it('plans insert only for insertable targets', () => {
    expect(mayInsert(snap({}))).toBe(true);
    expect(planDelivery(snap({}), true)).toEqual({
      action: 'insert',
      target: snap({}),
    });
  });

  it('refuses secure → Copy when fallback on', () => {
    const secure = snap({
      insertable: false,
      kind: 'secure',
      reason: 'secure field — insert skipped',
    });
    expect(planDelivery(secure, true)).toEqual({
      action: 'copy',
      kind: 'secure',
      reason: 'secure field — insert skipped',
    });
  });

  it('refuses secure → Fail when fallback off', () => {
    const secure = snap({
      insertable: false,
      kind: 'secure',
      reason: 'secure field — insert skipped',
    });
    expect(planDelivery(secure, false).action).toBe('fail');
  });

  it('plans Copy for closed / changed / unsupported when fallback on', () => {
    for (const kind of ['closed', 'changed', 'unsupported'] as const) {
      const t = snap({ insertable: false, kind, reason: `${kind} reason` });
      const plan = planDelivery(t, true);
      expect(plan.action).toBe('copy');
    }
  });
});

describe('shouldRestoreClipboard', () => {
  it('restores only when snapshot ok, write completed, no intervening copy', () => {
    expect(shouldRestoreClipboard({
      currentAfterOurWrite: 'ours',
      ourText: 'ours',
      ourWriteCompleted: true,
      priorText: 'prior',
      snapshotOk: true,
    })).toEqual({ restore: true, skipReason: null });
  });

  it('skips when no snapshot', () => {
    expect(shouldRestoreClipboard({
      currentAfterOurWrite: 'ours',
      ourText: 'ours',
      ourWriteCompleted: true,
      priorText: null,
      snapshotOk: false,
    }).restore).toBe(false);
  });

  it('skips when clipboard changed (user intervening copy)', () => {
    const r = shouldRestoreClipboard({
      currentAfterOurWrite: 'user-copied',
      ourText: 'ours',
      ourWriteCompleted: true,
      priorText: 'prior',
      snapshotOk: true,
    });
    expect(r.restore).toBe(false);
    expect(r.skipReason).toMatch(/changed/);
  });
});

describe('unavailableSnapshot', () => {
  it('marks non-insertable unavailable', () => {
    const u = unavailableSnapshot(42, 'no snap');
    expect(u.insertable).toBe(false);
    expect(u.kind).toBe('unavailable');
    expect(u.capturedAt).toBe(42);
  });
});
