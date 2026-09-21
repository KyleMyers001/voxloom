import { isTauri } from "@tauri-apps/api/core";

export interface ClipboardAdapter {
  copy(text: string): Promise<void>;
}

/** Injectable write for tests / alternate backends. */
export type ClipboardWriteFn = (text: string) => Promise<void>;

async function browserWriteText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard unavailable");
  await navigator.clipboard.writeText(text);
}

/**
 * Native clipboard write via Tauri plugin — no WebKit user-activation
 * requirement (fixes NotAllowedError after async STT on capture-stopped).
 */
async function tauriWriteText(text: string): Promise<void> {
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(text);
}

/**
 * Prefer Tauri native clipboard in the desktop shell; fall back to
 * `navigator.clipboard` for browser / unit tests.
 */
export function resolveClipboardWrite(
  write?: ClipboardWriteFn,
): ClipboardWriteFn {
  if (write) return write;
  if (isTauri()) return tauriWriteText;
  return browserWriteText;
}

export function createClipboardAdapter(
  shouldFail: () => boolean = () => false,
  write?: ClipboardWriteFn,
): ClipboardAdapter {
  const doWrite = resolveClipboardWrite(write);
  return {
    async copy(text: string) {
      if (shouldFail()) throw new Error("Simulated clipboard failure");
      await doWrite(text);
    },
  };
}
