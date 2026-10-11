//! Apple Messages (com.apple.MobileSMS) only: its composer exposes no
//! readable AXValue and, on Kyle's Air, ignores AXSelectedText sets while
//! returning success. Plan (docs/decisions/unreadable-axvalue.md):
//! 1. one AXSelectedText write, verified by polling `AXNumberOfCharacters`
//!    (~600 ms); exact delta => Inserted, other change => Unverified;
//! 2. only if the write returned Ok and the count stayed unchanged: two spaced
//!    unchanged reads (150 ms, 300 ms) so a late AX write cannot combine with
//!    typing, one more read right before the first chunk, then the guarded
//!    Unicode typing path, verified per chunk by count, and re-read ~300 ms
//!    after typing (moved off the expected total => Unverified);
//! 3. counts unreadable after an Ok write => Unverified, never Failed.
//!
//! Secure fields are refused before any of this (decide::web).

use super::length::after_ax_by_length;
use super::retry::RETRY_UNCHANGED_READS_MS;
use super::verify::{value_confirms_insert, AfterAx};

pub const MESSAGES_BUNDLE_ID: &str = "com.apple.MobileSMS";
pub const COUNT_POLLS: usize = 30;
pub const COUNT_POLL_MS: u64 = 20;
/// Re-read after typing to catch a late AX write overshooting the total.
pub const POST_TYPE_SETTLE_MS: u64 = 300;

/// The unreadable-AXValue path is allowlisted to Messages only.
pub fn unreadable_value_allowed(bundle_id: Option<&str>) -> bool {
    bundle_id == Some(MESSAGES_BUNDLE_ID)
}

/// Per-chunk typing confirmation: count equals the expected delta so far.
pub fn typed_count_ok(before: i64, selected: i64, now: Option<i64>, typed_utf16: i64) -> bool {
    now == Some(before - selected + typed_utf16)
}

pub trait UnreadableIo {
    /// Character count; the platform side falls back to the AXValue length.
    fn count(&mut self) -> Option<i64>;
    /// AXValue, when readable (used only to cross-check a success).
    fn value(&mut self) -> Option<String> {
        None
    }
    /// UTF-16 length of the current selection (0 for a caret), if readable.
    fn selected_len(&mut self) -> Option<i64>;
    fn sleep(&mut self, ms: u64);
    fn write_ax(&mut self) -> Result<(), String>;
    /// Guarded Unicode typing (focus re-check per chunk), each chunk confirmed
    /// with `typed_count_ok(before, selected, ..)`. Returns (posted, result).
    fn type_verified(&mut self, before: i64, selected: i64) -> (usize, Result<(), String>);
}

#[derive(Debug, PartialEq, Eq)]
pub enum UnreadableOutcome {
    Ax(AfterAx),
    Typed(usize, Result<(), String>),
    /// Typing completed but the count later moved off the expected total.
    TypedUnverified(usize),
}

/// Guarded Messages flow. When AXValue is readable (composer already holds
/// text, e.g. a second dictation), a success is additionally cross-checked
/// against the value: a readable value that doesn't prove the insert
/// downgrades to Unverified, and so does one that became unreadable.
/// Counts and lengths are UTF-16 code units (NSString/CFRange convention for
/// AXNumberOfCharacters, AXSelectedTextRange).
pub fn insert_unreadable(
    io: &mut impl UnreadableIo,
    text: &str,
    may_type: bool,
) -> UnreadableOutcome {
    let before_value = io.value();
    let outcome = flow(io, text.encode_utf16().count() as i64, may_type);
    let succeeded = matches!(
        outcome,
        UnreadableOutcome::Ax(AfterAx::Inserted) | UnreadableOutcome::Typed(_, Ok(()))
    );
    let Some(before_value) = before_value.filter(|_| succeeded) else {
        return outcome;
    };
    // Readable before but unreadable after is not proof either: Unverified.
    let confirmed = io
        .value()
        .is_some_and(|now| value_confirms_insert(&before_value, &now, text));
    match outcome {
        _ if confirmed => outcome,
        UnreadableOutcome::Typed(posted, _) => UnreadableOutcome::TypedUnverified(posted),
        _ => UnreadableOutcome::Ax(AfterAx::Unverified),
    }
}

fn flow(io: &mut impl UnreadableIo, text_utf16: i64, may_type: bool) -> UnreadableOutcome {
    let before = io.count();
    let selected = io.selected_len();
    let ax = io.write_ax();
    let mut last = AfterAx::Unverified;
    for poll in 0..COUNT_POLLS {
        if poll > 0 {
            io.sleep(COUNT_POLL_MS);
        }
        last = after_ax_by_length(ax.clone(), before, selected, io.count(), text_utf16);
        if last == AfterAx::Inserted {
            return UnreadableOutcome::Ax(last);
        }
    }
    let unchanged_after_ok = ax.is_ok() && matches!(last, AfterAx::Failed(_));
    let (Some(before), true, true) = (before, unchanged_after_ok, may_type) else {
        return UnreadableOutcome::Ax(last);
    };
    for wait in RETRY_UNCHANGED_READS_MS {
        io.sleep(wait);
        let now = io.count();
        if now != Some(before) {
            // Late AX landing (or another change): never type on top of it.
            return UnreadableOutcome::Ax(after_ax_by_length(
                Ok(()),
                Some(before),
                selected,
                now,
                text_utf16,
            ));
        }
    }
    // Last read right before the first typed chunk: if it moved, the late
    // AX write landed — never type on top of it.
    let now = io.count();
    if now != Some(before) {
        return UnreadableOutcome::Ax(after_ax_by_length(
            Ok(()),
            Some(before),
            selected,
            now,
            text_utf16,
        ));
    }
    // Caret assumed when the selection is unreadable; per-chunk count checks
    // stop typing on the first mismatch.
    let sel = selected.unwrap_or(0);
    let (posted, result) = io.type_verified(before, sel);
    if result.is_ok() {
        // A late AX write landing during/after typing would overshoot.
        io.sleep(POST_TYPE_SETTLE_MS);
        if !typed_count_ok(before, sel, io.count(), text_utf16) {
            return UnreadableOutcome::TypedUnverified(posted);
        }
    }
    UnreadableOutcome::Typed(posted, result)
}

#[cfg(test)]
#[path = "messages_tests.rs"]
mod tests;
