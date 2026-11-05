/** Provisional native targets from ADR (BUS-12). */
export const HOLD_MS = 320;
export const DOUBLE_TAP_MS = 260;

export const OVERLAY_WINDOW_LABEL = 'dictation-overlay';
/**
 * Listening/processing window: 24px of transparent halo clearance per side
 * around the 136×22 pill. The margin keeps the pill's original center
 * (28 + 28/2 === 4 + 76/2).
 */
export const OVERLAY_LISTEN_PLACEMENT = { height: 76, marginBottom: 4, width: 190 } as const;
/** Result HUD ("Copied · ⌘V to paste" / short error) needs a wider window. */
export const OVERLAY_RESULT_PLACEMENT = { height: 40, marginBottom: 28, width: 248 } as const;

/**
 * Post-arm window where Carbon Released is ignored (spurious focus/Released race).
 * After this, Carbon Released is a backup finish even while the Mac poll/tap watch
 * is monitoring — so a dead 2nd-session watch cannot leave Home on Stop forever.
 */
export const HOLD_RELEASE_CARBON_GRACE_MS = 80;
