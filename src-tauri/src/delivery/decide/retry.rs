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

/// `retry_once` result. `proven_unchanged` is true only when the retry write
/// returned Ok and read-back proved the field still unchanged: the one case
/// where typing cannot duplicate text.
#[derive(Debug, PartialEq, Eq)]
pub struct RetryOutcome {
    pub after: AfterAx,
    pub proven_unchanged: bool,
}

fn done(after: AfterAx) -> RetryOutcome {
    RetryOutcome {
        after,
        proven_unchanged: false,
    }
}

pub fn retry_once(
    first_write: &Result<(), String>,
    before: &str,
    text: &str,
    io: &mut impl RetryIo,
) -> RetryOutcome {
    if let Err(err) = first_write {
        return done(AfterAx::Failed(err.clone())); // Never retry after an AX error.
    }
    io.reassert();
    for wait in RETRY_UNCHANGED_READS_MS {
        io.sleep(wait);
        match io.read() {
            Some(now) if value_confirms_insert(before, &now, text) => {
                return done(AfterAx::Inserted)
            }
            Some(now) if same_ax_text(&now, before) => {}
            Some(_) => return done(AfterAx::Unverified),
            None => {
                let msg = "AXValue unreadable before retry — insert skipped";
                return done(AfterAx::Failed(msg.into()));
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
            return done(AfterAx::Inserted);
        }
    }
    let proven_unchanged =
        result.is_ok() && last.as_deref().is_some_and(|now| same_ax_text(now, before));
    // may_type=false: typing is decided by `type_after_retry`.
    let after = after_ax(false, result, before, last.as_deref(), text);
    RetryOutcome {
        after,
        proven_unchanged,
    }
}

/// After the retry re-enabled web AX, the tree is complete again, so a field
/// whose web identity was invisible to the first `may_type` check can now be
/// proven to be web content. In a recognised Chromium/Electron host
/// (`typing_ok`) the web probe may still miss (Chrome keeps some fields
/// outside the AXWebArea subtree), so typing is also allowed there whenever
/// read-back PROVED the field unchanged after an Ok retry write. Codex P1:
/// any other Failed (unreadable AXValue, write error, target changed) stays
/// Failed so text is never duplicated.
pub fn type_after_retry(retried: RetryOutcome, web_field_now: bool, typing_ok: bool) -> AfterAx {
    match retried.after {
        AfterAx::Failed(_) if retried.proven_unchanged && typing_ok => {
            let _ = web_field_now; // informative only once the host is recognised
            AfterAx::TypeFallback
        }
        other => other,
    }
}

#[cfg(test)]
#[path = "retry_tests.rs"]
mod tests;
