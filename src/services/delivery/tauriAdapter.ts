/**
 * Tauri bridge to macOS AX delivery commands (cfg-gated in Rust).
 * Falls back to stub behavior when invoke is unavailable.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";

import type { ClipboardAdapter } from "../clipboard";
import { createStubDeliveryAdapter } from "./stubAdapter";
import type {
  ClipboardSnapshot,
  DeliveryPlatformAdapter,
  TargetSnapshot,
} from "./types";

interface NativeTargetDto {
  appName: string | null;
  appPid: number | null;
  capturedAt: number;
  elementId: string | null;
  elementRole: string | null;
  insertable: boolean;
  kind: TargetSnapshot["kind"];
  reason: string | null;
}

function fromDto(dto: NativeTargetDto): TargetSnapshot {
  return {
    appName: dto.appName,
    appPid: dto.appPid,
    capturedAt: dto.capturedAt,
    elementId: dto.elementId,
    elementRole: dto.elementRole,
    insertable: dto.insertable,
    kind: dto.kind,
    reason: dto.reason,
  };
}

async function tauriClipboardRead(): Promise<ClipboardSnapshot> {
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    const text = await readText();
    return { ok: true, text: text ?? "" };
  } catch {
    return { ok: false, text: null };
  }
}

/**
 * Prefer native AX commands when running under Tauri; otherwise stub.
 */
export function createTauriDeliveryAdapter(
  clipboard: ClipboardAdapter,
): DeliveryPlatformAdapter {
  if (!isTauri()) {
    return createStubDeliveryAdapter({ clipboard });
  }

  const stub = createStubDeliveryAdapter({
    clipboard,
    clipboardRead: tauriClipboardRead,
  });

  return {
    clipboardRead: () => stub.clipboardRead(),
    clipboardRestore: (prior) => stub.clipboardRestore(prior),
    clipboardWrite: (text) => stub.clipboardWrite(text),
    async insertText(text, intended) {
      await invoke("delivery_insert_text", {
        text,
        intended,
      });
    },
    async snapshotTarget() {
      try {
        const dto = await invoke<NativeTargetDto>("delivery_snapshot_target");
        return fromDto(dto);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return stub.snapshotTarget().then((snap) => ({
          ...snap,
          reason: `native snapshot failed: ${detail}`,
        }));
      }
    },
    async validateTarget(intended) {
      try {
        const dto = await invoke<NativeTargetDto>("delivery_validate_target", {
          intended,
        });
        return fromDto(dto);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ...intended,
          insertable: false,
          kind: "unavailable",
          reason: `native validate failed: ${detail}`,
        };
      }
    },
  };
}
