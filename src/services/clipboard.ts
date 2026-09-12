export interface ClipboardAdapter {
  copy(text: string): Promise<void>;
}

export function createClipboardAdapter(
  shouldFail: () => boolean = () => false,
): ClipboardAdapter {
  return {
    async copy(text: string) {
      if (shouldFail()) throw new Error("Simulated clipboard failure");
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
    },
  };
}
