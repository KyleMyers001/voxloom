export { DOUBLE_TAP_MS, HOLD_MS, OVERLAY_WINDOW_LABEL } from "./constants";
export { createDocumentShortcutController } from "./documentAdapter";
export { matchesShortcut, toPluginHotkey } from "./formatHotkey";
export {
  createGestureMachine,
  type GestureMachine,
  type KeyEdge,
} from "./gestureMachine";
export {
  HOLD_RELEASE_EVENT,
  createTauriHoldReleaseApi,
  type HoldReleaseApi,
} from "./holdReleaseBridge";
export {
  createNativeShortcutController,
  createTauriShortcutApi,
  type NativeShortcutApi,
  type NativeShortcutController,
} from "./nativeRegistration";
export {
  createOverlayBridge,
  overlaySyncPlan,
  type OverlayBridge,
} from "./overlayBridge";
export {
  isOverlayVisible,
  overlayWaveformFromDictation,
} from "./overlayVisibility";
export {
  createPendingFinishGate,
  type PendingFinishGate,
  type PendingFinishGateOptions,
} from "./pendingFinish";
export {
  registerOrRevert,
  type RegisterOutcome,
  type ShortcutBinder,
} from "./registerOrRevert";
