//! Keeps an active CGEventTap from outliving its Accessibility grant
//! (BUS-209). An active tap holds every event it matches until its callback
//! returns; one left armed after Accessibility is turned off can stop all
//! keyboard and trackpad input. So a tap is only re-enabled while access is
//! still granted and within a budget, and torn down as soon as access goes.
//!
//! The permission check waits on the window server, so it runs on its own
//! checker thread (`monitor`) and publishes a flag. Tap threads and the Esc
//! timer only read that flag: a thread that services a tap never waits on
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
pub use monitor::AccessWatch;
#[cfg_attr(not(target_os = "macos"), allow(unused_imports))]
use monitor::Monitor;

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
    Keep,
    Reenable,
    TearDown,
}

/// Per-tap watchdog state: recent re-enables and the last timeout.
#[derive(Default)]
pub struct TapGuard {
    reenabled: VecDeque<Instant>,
    last_timeout: Option<Instant>,
}

impl TapGuard {
    /// Decide after a run-loop slice, from the disables seen since the last
    /// check and the checker's latest verdict. Lost access always tears
    /// down; so do consecutive timeouts. Otherwise a disabled tap is
    /// re-enabled within the budget.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn check(&mut self, disables: Disables, trusted: bool, now: Instant) -> Verdict {
        if !trusted {
            return Verdict::TearDown;
        }
        if !disables.any() {
            return Verdict::Keep;
        }
        if disables.timeouts > 0 {
            let recent = self
                .last_timeout
                .is_some_and(|at| now.saturating_duration_since(at) < TIMEOUT_REPEAT_WINDOW);
            self.last_timeout = Some(now);
            if recent || disables.timeouts > 1 {
                return Verdict::TearDown;
            }
        }
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
