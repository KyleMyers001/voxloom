/**
 * Non-macOS / browser stub: no AX insert. Snapshot reports unavailable.
 * Clipboard uses the injectable / resolved write path.
 */

import type { ClipboardAdapter } from "../clipboard";
import type {
  ClipboardSnapshot,
  DeliveryPlatformAdapter,
  TargetSnapshot,
} from "./types";
import { unavailableSnapshot } from "./policy";

export interface StubAdapterOptions {
  clipboard: ClipboardAdapter;
  /** Optional injectable read (tests / Tauri read plugin). */
  clipboardRead?: () => Promise<ClipboardSnapshot>;
  now?: () => number;
  /** Override snapshot (tests inject secure/closed/etc.). */
  snapshot?: () => Promise<TargetSnapshot>;
  validate?: (
    intended: TargetSnapshot,
  ) => Promise<TargetSnapshot>;
  insert?: (text: string, intended: TargetSnapshot) => Promise<void>;
}

export function createStubDeliveryAdapter(
  options: StubAdapterOptions,
): DeliveryPlatformAdapter {
  const now = options.now ?? Date.now;
  const defaultRead = async (): Promise<ClipboardSnapshot> => ({
    ok: false,
    text: null,
  });

  return {
    async clipboardRead() {
      if (options.clipboardRead) return options.clipboardRead();
      return defaultRead();
    },
    async clipboardRestore(prior: string) {
      await options.clipboard.copy(prior);
    },
    async clipboardWrite(text: string) {
      await options.clipboard.copy(text);
    },
    async insertText(text: string, intended: TargetSnapshot) {
      if (options.insert) {
        await options.insert(text, intended);
        return;
      }
      throw new Error(
        "insert unavailable on this platform (macOS AX adapter required)",
      );
    },
    async snapshotTarget() {
      if (options.snapshot) return options.snapshot();
      return unavailableSnapshot(
        now(),
        "Accessibility insert is macOS-only in this build",
      );
    },
    async validateTarget(intended: TargetSnapshot) {
      if (options.validate) return options.validate(intended);
      // Without a live AX probe, refuse insert; Copy fallback may still run.
      return {
        ...intended,
        insertable: false,
        kind: intended.kind === "insertable" ? "unavailable" : intended.kind,
        reason: intended.reason
          ?? "Accessibility insert is macOS-only in this build",
      };
    },
  };
}
