/**
 * BUS-46: tell a deliberate tap of a lone modifier from a modifier that is
 * part of a chord. A keydown cannot say which: Option alone and Option+E both
 * begin with Option going down. So the recorder tracks the held modifier and
 * a "dirty" flag, and decides on keyup: clean means nothing else was pressed
 * in between, dirty means it was a chord (Option+E, Option+Shift) or a second
 * modifier joined it.
 */
import {
  isLeftModifier, isLoneModifier, normalizeModifierCode, rightHandOf,
  type LoneModifierCode,
} from './loneKey';

export interface LoneTracker {
  held: string | null;
  dirty: boolean;
}

export const IDLE: LoneTracker = { dirty: false, held: null };

export type LoneRelease =
  /** A clean tap of a right-hand modifier: save it. */
  | { kind: 'captured'; combo: LoneModifierCode }
  /** A clean tap of a left-hand modifier: suggest the right-hand one. */
  | { kind: 'left'; code: string; suggest: LoneModifierCode | null }
  /** A chord ended with every modifier up: nothing to save. */
  | { kind: 'chord' }
  | { kind: 'ignore' };

/** A modifier went down (`code` as KeyboardEvent.code, repeats included). */
export function modifierDown(t: LoneTracker, rawCode: string): LoneTracker {
  const code = normalizeModifierCode(rawCode);
  if (t.held === null) return { dirty: false, held: code };
  return t.held === code ? t : { ...t, dirty: true };
}

/** A non-modifier key or mouse button went down while recording. */
export function otherDown(t: LoneTracker): LoneTracker {
  return t.held === null ? t : { ...t, dirty: true };
}

/** A modifier-capable key came up; `anyModifierDown` is the event's flags. */
export function keyUp(
  t: LoneTracker, rawCode: string, anyModifierDown: boolean,
): { next: LoneTracker; release: LoneRelease } {
  const code = normalizeModifierCode(rawCode);
  if (t.held === null) return { next: t, release: { kind: 'ignore' } };
  if (t.dirty) {
    // Wait until every modifier is up before calling the chord over.
    return anyModifierDown
      ? { next: t, release: { kind: 'ignore' } }
      : { next: IDLE, release: { kind: 'chord' } };
  }
  if (code !== t.held) return { next: t, release: { kind: 'ignore' } };
  if (isLoneModifier(code)) return { next: IDLE, release: { combo: code, kind: 'captured' } };
  if (isLeftModifier(code)) {
    return { next: IDLE, release: { code, kind: 'left', suggest: rightHandOf(code) } };
  }
  return { next: IDLE, release: { kind: 'chord' } };
}
