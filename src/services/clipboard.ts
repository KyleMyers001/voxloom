import { isTauri } from "@tauri-apps/api/core";

export interface ClipboardAdapter {
  copy(text: string): Promise<void>;
  /** Optional plain-text read for restore / conflict checks (BUS-14). */
  read?(): Promise<string | null>;
}

/** Injectable write for tests / alternate backends. */
export type ClipboardWriteFn = (text: string) => Promise<void>;
/** Injectable read for tests / alternate backends. */
export type ClipboardReadFn = () => Promise<string | null>;

async function browserWriteText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard unavailable");
  await navigator.clipboard.writeText(text);
}

async function browserReadText(): Promise<string | null> {
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * Native clipboard write via Tauri plugin — no WebKit user-activation
 * requirement (fixes NotAllowedError after async STT on capture-stopped).
 */
async function tauriWriteText(text: string): Promise<void> {
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(text);
}

async function tauriReadText(): Promise<string | null> {
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    const text = await readText();
    return text ?? "";
  } catch {
    return null;
  }
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

export function resolveClipboardRead(
  read?: ClipboardReadFn,
): ClipboardReadFn {
  if (read) return read;
  if (isTauri()) return tauriReadText;
  return browserReadText;
}

export function createClipboardAdapter(
  shouldFail: () => boolean = () => false,
  write?: ClipboardWriteFn,
  read?: ClipboardReadFn,
): ClipboardAdapter {
  const doWrite = resolveClipboardWrite(write);
  const doRead = resolveClipboardRead(read);
  return {
    async copy(text: string) {
      if (shouldFail()) throw new Error("Simulated clipboard failure");
      await doWrite(text);
    },
    async read() {
      if (shouldFail()) throw new Error("Simulated clipboard failure");
      return doRead();
    },
  };
}
