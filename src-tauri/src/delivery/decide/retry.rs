//! One guarded retry after "AXSelectedText reported success but nothing
//! changed" in a Chromium/Electron host: the web AX tree may have been dropped
//! while idle. Rules (no double insert):
//! - only when the first write returned Ok AND the field read back unchanged;
//!   never after an AX error;
//! - re-assert, then require TWO unchanged reads (after 150 ms, then 300 ms);
//!   a late landing of the first write on either read => Inserted, no write;
//!   any other change => Unverified, no write;
//! - after the single retry write, poll the read-back (like `wait_for_insert`).

use super::verify::{after_ax, same_ax_text, value_confirms_insert, AfterAx};

/// Waits before each of the two "still unchanged" reads.
pub const RETRY_UNCHANGED_READS_MS: [u64; 2] = [150, 300];
/// Read-back polling after the retry write (~600 ms total).
pub const RETRY_READBACK_POLLS: usize = 30;
pub const RETRY_READBACK_POLL_MS: u64 = 20;

/// Side effects of the retry, injected for tests.
pub trait RetryIo {
    /// Re-enable the host's web AX attribute.
    fn reassert(&mut self);
    fn sleep(&mut self, ms: u64);
    /// The field's current AXValue.
    fn read(&mut self) -> Option<String>;
    /// The single AXSelectedText write; must re-check focus itself.
    fn write(&mut self) -> Result<(), String>;
}

/// Whether the first attempt qualifies for the retry at all.
pub fn retry_eligible(first_write: &Result<(), String>, outcome: &AfterAx, web_host: bool) -> bool {
    web_host && first_write.is_ok() && matches!(outcome, AfterAx::Failed(_))
}

pub fn retry_once(
    first_write: &Result<(), String>,
    before: &str,
    text: &str,
    io: &mut impl RetryIo,
) -> AfterAx {
    if let Err(err) = first_write {
        return AfterAx::Failed(err.clone()); // Never retry after an AX error.
    }
    io.reassert();
    for wait in RETRY_UNCHANGED_READS_MS {
        io.sleep(wait);
        match io.read() {
            Some(now) if value_confirms_insert(before, &now, text) => return AfterAx::Inserted,
            Some(now) if same_ax_text(&now, before) => {}
            Some(_) => return AfterAx::Unverified,
            None => {
                return AfterAx::Failed("AXValue unreadable before retry — insert skipped".into())
            }
        }
    }
    let result = io.write();
    let mut last = None;
    for poll in 0..RETRY_READBACK_POLLS {
        if poll > 0 {
            io.sleep(RETRY_READBACK_POLL_MS);
        }
        last = io.read();
        if last
            .as_deref()
            .is_some_and(|now| value_confirms_insert(before, now, text))
        {
            return AfterAx::Inserted;
        }
    }
    // may_type=false: the typing fallback is decided before this retry.
    after_ax(false, result, before, last.as_deref(), text)
}

#[cfg(test)]
#[path = "retry_tests.rs"]
mod tests;
