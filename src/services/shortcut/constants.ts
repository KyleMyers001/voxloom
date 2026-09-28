/** Provisional native targets from ADR (BUS-12). */
export const HOLD_MS = 320;
export const DOUBLE_TAP_MS = 260;

export const OVERLAY_WINDOW_LABEL = "dictation-overlay";
export const OVERLAY_WIDTH = 84;
export const OVERLAY_HEIGHT = 28;
export const OVERLAY_BOTTOM_MARGIN = 28;

/**
 * Post-arm window where Carbon Released is ignored (spurious focus/Released race).
 * After this, Carbon Released is a backup finish even while the Mac poll/tap watch
 * is monitoring — so a dead 2nd-session watch cannot leave Home on Stop forever.
 */
export const HOLD_RELEASE_CARBON_GRACE_MS = 80;
