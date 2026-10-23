/// Cleanup prewarm (BUS-16 3c-2c C2): load and warm the cleanup model ahead
/// of the first dictation, so the cold load doesn't come out of its 10 s
/// budget. Native decides the rest (src-tauri/src/cleanup/prewarm.rs): it
/// skips a launch prewarm in macOS Low Power Mode, needs a worker and a
/// verified model, runs at most one, and hands a dictation that arrives
/// mid-prewarm to the same load. No UI: the result is ignored.

import { invoke } from '@tauri-apps/api/core';

/**
 * How long after launch the prewarm waits, so the window, settings and
 * speech model come up first. Provisional: tuned on Qwen3-1.7B after
 * BUS-114 with Mac timings.
 */
export const PREWARM_LAUNCH_DELAY_MS = 5_000;

export type PrewarmTrigger = 'launch' | 'switch-on';

export type Prewarm = (trigger: PrewarmTrigger) => Promise<unknown>;

export const prewarmCleanup: Prewarm = (trigger) => invoke('cleanup_prewarm', { trigger });

export type DisarmPrewarm = () => Promise<unknown>;

/**
 * Cleanup was switched off: end a prewarm that is hashing or loading, and
 * stop one that was cut off from restarting. Never touches a dictation
 * (src-tauri/src/cleanup/prewarm.rs).
 */
export const disarmCleanupPrewarm: DisarmPrewarm = () => invoke('cleanup_prewarm_disarm');
