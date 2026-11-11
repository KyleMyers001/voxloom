//! Keeps an active CGEventTap from outliving its Accessibility grant
//! (BUS-209). An active tap holds every event it matches until its callback
//! returns; one left armed after Accessibility is turned off can stop all
//! keyboard and trackpad input. So a disabled tap stays off until a check
//! that started after the disable finds access still granted, is then
//! re-enabled within a budget, and is torn down as soon as access goes.
//!
//! The permission check waits on the window server, so it runs on its own
//! checker thread (`monitor`) and publishes the result. Tap threads and the
//! Esc timer only read it: a thread that services a tap never waits on
//! the window server while the window server may be waiting on its callback.
//!
//! The decisions here are plain `std` (tested everywhere); the probe is
//! macOS only.

mod monitor;
#[cfg(target_os = "macos")]
mod probe;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[cfg_attr(not(target_os = "macos"), allow(unused_imports))]
use monitor::Monitor;
#[cfg_attr(not(target_os = "macos"), allow(unused_imports))]
pub use monitor::{Access, AccessWatch};

/// Re-enables allowed per `REENABLE_WINDOW`; one more and the tap fails
/// closed (a tap macOS keeps disabling is not worth fighting).
pub const REENABLE_LIMIT: usize = 3;
pub const REENABLE_WINDOW: Duration = Duration::from_secs(10);
/// A second timeout-disable this soon after the last one means the tap
/// can't keep up (or access is going): fail closed, don't re-enable.
pub const TIMEOUT_REPEAT_WINDOW: Duration = Duration::from_secs(5);
/// How often the checker thread probes while any tap is armed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const CHECK_INTERVAL: Duration = Duration::from_millis(250);

/// The disable events a tap callback saw since the watchdog last looked.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Disables {
    /// kCGEventTapDisabledByTimeout
    pub timeouts: u32,
    /// kCGEventTapDisabledByUserInput
    pub user_input: u32,
}

impl Disables {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn note(&mut self, timeout: bool) {
        let count = if timeout {
            &mut self.timeouts
        } else {
            &mut self.user_input
        };
        *count = count.saturating_add(1);
    }

    fn any(self) -> bool {
        self.timeouts > 0 || self.user_input > 0
    }
}

/// What to do with a tap after one watchdog check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Leave it as it is.
    Keep,
    /// It is disabled: leave it off until a check that started after the
    /// disable reports. Nudge the checker (`AccessWatch::nudge`).
    AwaitCheck,
    Reenable,
    TearDown,
}

/// Per-tap watchdog state: recent re-enables, the last timeout, and
/// whether the tap is disabled awaiting a fresh check.
#[derive(Default)]
pub struct TapGuard {
    reenabled: VecDeque<Instant>,
    last_timeout: Option<Instant>,
    /// While the tap is disabled: the newest check that had started when
    /// the disable was seen. Only a later check can clear a re-enable.
    disabled_after: Option<u64>,
}

impl TapGuard {
    /// Decide after a run-loop slice, from the disables seen since the last
    /// check and what the checker has published. Lost access always tears
    /// down; so do consecutive timeouts. A disabled tap stays off until a
    /// check that started after the disable finds access granted: the
    /// published `trusted` can predate the revoke that caused the disable.
    /// Then it is re-enabled within the budget.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn check(&mut self, disables: Disables, access: Access, now: Instant) -> Verdict {
        if !access.trusted {
            return Verdict::TearDown;
        }
        if disables.any() {
            if disables.timeouts > 0 {
                let recent = self
                    .last_timeout
                    .is_some_and(|at| now.saturating_duration_since(at) < TIMEOUT_REPEAT_WINDOW);
                self.last_timeout = Some(now);
                if recent || disables.timeouts > 1 {
                    return Verdict::TearDown;
                }
            }
            // `started` only grows, so a later disable waits at least as long.
            self.disabled_after = Some(access.started);
        }
        let Some(after) = self.disabled_after else {
            return Verdict::Keep;
        };
        if access.granted <= after {
            return Verdict::AwaitCheck;
        }
        self.disabled_after = None;
        while let Some(&oldest) = self.reenabled.front() {
            if now.saturating_duration_since(oldest) < REENABLE_WINDOW {
                break;
            }
            self.reenabled.pop_front();
        }
        if self.reenabled.len() >= REENABLE_LIMIT {
            return Verdict::TearDown;
        }
        self.reenabled.push_back(now);
        Verdict::Reenable
    }
}

#[cfg(target_os = "macos")]
static ACCESS: std::sync::LazyLock<Monitor> =
    std::sync::LazyLock::new(|| Monitor::new(probe::still_trusted, CHECK_INTERVAL));

/// Start watching Accessibility for a tap that was just created (which
/// proves access right now). Keep the watch as long as the tap; read it
/// with `AccessWatch::trusted`. Never waits on the window server.
#[cfg(target_os = "macos")]
pub fn watch_access() -> Result<AccessWatch, String> {
    ACCESS.watch()
}
