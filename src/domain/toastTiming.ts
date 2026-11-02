/// How long a toast stays: never shorter than its base, and long enough to
/// read at about 240 words per minute.

const MS_PER_WORD = 250;

export function toastMs(message: string, baseMs: number): number {
  const words = message.split(/\s+/).filter(Boolean).length;
  return Math.max(baseMs, words * MS_PER_WORD);
}
