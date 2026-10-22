/// BUS-16 3c-2c: how long cleanup may take, and which dictations it skips.
/// The thresholds are provisional: they are tuned on Qwen3-1.7B after the
/// BUS-114 model switch and the Build C Mac timings, not on today's 0.6B.

/**
 * One budget, end to end: what the user waits for between the transcript
 * and delivery, including the model lease and its re-hash (product call,
 * BUS-16 3c-2c). A timeout falls back to the raw text, as every failure does.
 */
export const CLEANUP_BUDGET_MS = 10_000;

/**
 * Provisional: above this many words the raw text is delivered without
 * trying, because the reply would not fit the budget (about 125 words at
 * 22 tokens/s on a base M2 with 1.7B; see /workspace/pr3c-design.md).
 */
export const CLEANUP_MAX_WORDS = 120;

/** Whitespace-separated words, the same rough count dictation UIs show. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export function tooLongToClean(text: string): boolean {
  return wordCount(text) > CLEANUP_MAX_WORDS;
}
