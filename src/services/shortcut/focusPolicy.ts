/**
 * ADR §3 (native-shortcut-cancel-focus): ordinary other-app focus must not
 * cancel an in-flight hold/latch or reset native gesture state.
 *
 * Document (focused-window) adapters still reset on visibilitychange / pagehide
 * because a blurred window will miss keyup and leave a zombie partial gesture.
 * The native global-shortcut path must not — registration and the Mac
 * hold-release watch stay process-lifetime / hold-scoped and keep working
 * while another app is frontmost.
 */
export type ShortcutInputSource = "document-focused" | "native-global";

export function shouldResetGesturesOnDocumentHidden(
  source: ShortcutInputSource,
): boolean {
  return source === "document-focused";
}
