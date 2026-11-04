/// Leaves code-like text alone (BUS-138): a dictionary match that touches code
/// punctuation with no space in between ("src/voxloom", "voxloom.app",
/// "macos:assert") is a path, URL or identifier, not something that was said.
/// Hyphens are not code punctuation here, so "GitHub-hosted" still works.

const CODE_BEFORE = /[/\\@:~$#=%]$/u;
const DOT_AFTER_WORD = /[\p{L}\p{M}\p{N}_]\.$/u;
// A colon counts only when something follows it right away ("tauri::new"),
// not in prose ("tauri: a framework", or one at the end of the text).
const CODE_AFTER = /^(?:[/\\@=]|:\S)/u;
const DOT_THEN_WORD = /^\.[\p{L}\p{N}]/u;

/**
 * True when the match at `start..end` of `text` sits inside code-like text.
 * Before it: one of `/ \ @ : ~ $ # = %`, or a `.` that follows a word
 * character. After it: one of `/ \ @ =`, a colon followed by a non-space, or a
 * `.` followed by a letter or digit. (`_` is a word character, so the match
 * boundary already keeps it out.)
 */
export function touchesCode(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 4), start);
  const after = text.slice(end, end + 3);
  return CODE_BEFORE.test(before) || DOT_AFTER_WORD.test(before)
    || CODE_AFTER.test(after) || DOT_THEN_WORD.test(after);
}
