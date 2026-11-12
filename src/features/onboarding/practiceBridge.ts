import type { ShortcutGesture } from '../../services/contracts';

let handler: ((gesture: ShortcutGesture) => void) | null = null;
const resets = new Set<() => void>();
/** The mounted note owns practice. A gesture alone can never complete it. */
export function registerPracticeHandler(next: (gesture: ShortcutGesture) => void): () => void {
  handler = next;
  return () => { if (handler === next) handler = null; resetPracticeGestures(); };
}
export function dispatchPracticeGesture(gesture: ShortcutGesture): void { handler?.(gesture); }
export function resetPracticeGestures(): void { resets.forEach((fn) => fn()); }
export function subscribePracticeReset(fn: () => void): () => void {
  resets.add(fn);
  return () => { resets.delete(fn); };
}
