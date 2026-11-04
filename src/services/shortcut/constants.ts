/** Provisional native targets from ADR (BUS-12). */
export const HOLD_MS = 320;
export const DOUBLE_TAP_MS = 260;

export const OVERLAY_WINDOW_LABEL = 'dictation-overlay';
/** Room for the listening ripple effect around the unchanged slim pill. */
export const OVERLAY_EFFECT_PADDING = 24;
export const OVERLAY_WIDTH = 142 + OVERLAY_EFFECT_PADDING * 2;
export const OVERLAY_HEIGHT = 28 + OVERLAY_EFFECT_PADDING * 2;
export const OVERLAY_BOTTOM_MARGIN = 28;
/** Compensate for the taller envelope, keeping the visible pill centered. */
export const OVERLAY_LISTEN_BOTTOM_MARGIN = OVERLAY_BOTTOM_MARGIN - OVERLAY_EFFECT_PADDING;
/** Result HUD ("Copied · ⌘V to paste" / short error) needs a wider window. */
export const OVERLAY_RESULT_WIDTH = 248;
export const OVERLAY_RESULT_HEIGHT = 40;

/**
 * Post-arm window where Carbon Released is ignored (spurious focus/Released race).
 * After this, Carbon Released is a backup finish even while the Mac poll/tap watch
 * is monitoring — so a dead 2nd-session watch cannot leave Home on Stop forever.
 */
export const HOLD_RELEASE_CARBON_GRACE_MS = 80;
