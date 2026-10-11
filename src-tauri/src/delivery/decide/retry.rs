//! One guarded retry after "AXSelectedText reported success but nothing
//! changed" in a Chromium/Electron host: the web AX tree may have been dropped
//! while idle. Re-assert accessibility, settle, RE-READ the value, and only
//! write again if the field is still exactly as before (no double insert).

use super::verify::{after_ax, same_ax_text, value_confirms_insert, AfterAx};

/// Settle time after re-asserting accessibility before re-reading.
pub const RETRY_SETTLE_MS: u64 = 150;

/// `reassert_and_settle` re-enables web AX and waits; `read` returns the
/// field's current AXValue; `write` performs the single AXSelectedText write
/// (and must itself re-check focus).
pub fn retry_once(
    before: &str,
    text: &str,
    reassert_and_settle: impl FnOnce(),
    read: impl Fn() -> Option<String>,
    write: impl FnOnce() -> Result<(), String>,
) -> AfterAx {
    reassert_and_settle();
    match read() {
        // The first write landed late: done, never write again.
        Some(now) if value_confirms_insert(before, &now, text) => AfterAx::Inserted,
        Some(now) if same_ax_text(&now, before) => {
            let result = write();
            let after = read();
            // may_type=false: the typing fallback is decided before this retry.
            after_ax(false, result, before, after.as_deref(), text)
        }
        // Changed by someone else, or partially: never mutate again.
        Some(_) => AfterAx::Unverified,
        None => AfterAx::Failed("AXValue unreadable before retry — insert skipped".into()),
    }
}

#[cfg(test)]
#[path = "retry_tests.rs"]
mod tests;
