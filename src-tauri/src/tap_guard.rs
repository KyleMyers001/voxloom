//! Keeps an active CGEventTap from outliving its Accessibility grant
//! (BUS-209). An active tap holds every event it matches until its callback
//! returns; one left armed after Accessibility is turned off can stop all
//! keyboard and trackpad input. So a tap is only re-enabled while access is
//! still granted and within a budget, and torn down as soon as access goes.
//!
//! The decisions are plain `std` (tested everywhere); the permission check
//! at the bottom is macOS only. It may wait on the window server, so it runs
//! between run-loop slices (or from a timer), never inside a tap callback.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Re-enables allowed per `REENABLE_WINDOW`; one more and the tap fails
/// closed (a tap macOS keeps disabling is not worth fighting).
pub const REENABLE_LIMIT: usize = 10;
pub const REENABLE_WINDOW: Duration = Duration::from_secs(10);

/// What to do with a tap after one watchdog check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Keep,
    Reenable,
    TearDown,
}

/// Per-tap watchdog state: the recent re-enables.
#[derive(Default)]
pub struct TapGuard {
    reenabled: VecDeque<Instant>,
}

impl TapGuard {
    /// Decide after a run-loop slice. `disabled` says macOS disabled the tap
    /// since the last check. Lost access always tears down; a disabled tap
    /// is re-enabled only within the budget.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn check(
        &mut self,
        disabled: bool,
        trusted: impl FnOnce() -> bool,
        now: Instant,
    ) -> Verdict {
        if !trusted() {
            return Verdict::TearDown;
        }
        if !disabled {
            return Verdict::Keep;
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
pub use access::still_trusted;

#[cfg(target_os = "macos")]
mod access {
    use std::ffi::c_void;
    use std::ptr;

    type Handle = *mut c_void;
    type Callback = unsafe extern "C" fn(Handle, u32, Handle, Handle) -> Handle;

    const TAP_SESSION: u32 = 1; // kCGSessionEventTap
    const TAP_TAIL: u32 = 1; // kCGTailAppendEventTap
    const TAP_DEFAULT: u32 = 0; // kCGEventTapOptionDefault (active)
    const MASK_NULL: u64 = 1; // CGEventMaskBit(kCGEventNull)

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        // Apple AXUIElement.h: Boolean (UInt8). Never prompts.
        fn AXIsProcessTrusted() -> u8;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            location: u32,
            place: u32,
            options: u32,
            mask: u64,
            callback: Callback,
            context: Handle,
        ) -> Handle;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortInvalidate(port: Handle);
        fn CFRelease(value: *const c_void);
    }

    unsafe extern "C" fn pass(_: Handle, _: u32, event: Handle, _: Handle) -> Handle {
        event
    }

    /// Whether an active tap is still allowed. `AXIsProcessTrusted` alone
    /// can stay true after the app's Accessibility row is deleted, so also
    /// create a throwaway active tap the way ours are created (an active
    /// tap is what Accessibility authorizes; a listen-only one would test
    /// Input Monitoring instead). It matches only null events, is never
    /// added to a run loop, and is invalidated at once, so it holds nothing.
    pub fn still_trusted() -> bool {
        // SAFETY: a preflight query, then a create-rule port released
        // exactly once; the probe has no context and is never run.
        unsafe {
            if AXIsProcessTrusted() == 0 {
                return false;
            }
            let probe = CGEventTapCreate(
                TAP_SESSION,
                TAP_TAIL,
                TAP_DEFAULT,
                MASK_NULL,
                pass,
                ptr::null_mut(),
            );
            if probe.is_null() {
                return false;
            }
            CFMachPortInvalidate(probe);
            CFRelease(probe);
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lost_access_tears_down_even_when_the_tap_was_not_disabled() {
        let mut guard = TapGuard::default();
        let now = Instant::now();
        assert_eq!(guard.check(false, || false, now), Verdict::TearDown);
        assert_eq!(guard.check(true, || false, now), Verdict::TearDown);
    }

    #[test]
    fn a_running_tap_with_access_is_kept() {
        let mut guard = TapGuard::default();
        assert_eq!(guard.check(false, || true, Instant::now()), Verdict::Keep);
    }

    #[test]
    fn a_disabled_tap_is_reenabled_only_with_access() {
        let mut guard = TapGuard::default();
        assert_eq!(
            guard.check(true, || true, Instant::now()),
            Verdict::Reenable
        );
    }

    #[test]
    fn the_permission_check_runs_every_time() {
        let mut guard = TapGuard::default();
        let mut checks = 0;
        for disabled in [false, true] {
            guard.check(
                disabled,
                || {
                    checks += 1;
                    true
                },
                Instant::now(),
            );
        }
        assert_eq!(checks, 2);
    }

    #[test]
    fn past_the_budget_a_disabled_tap_fails_closed() {
        let mut guard = TapGuard::default();
        let start = Instant::now();
        for i in 0..REENABLE_LIMIT {
            let at = start + Duration::from_millis(i as u64 * 100);
            assert_eq!(guard.check(true, || true, at), Verdict::Reenable, "{i}");
        }
        let at = start + Duration::from_secs(5);
        assert_eq!(guard.check(true, || true, at), Verdict::TearDown);
    }

    #[test]
    fn re_enables_older_than_the_window_free_the_budget() {
        let mut guard = TapGuard::default();
        let start = Instant::now();
        for _ in 0..REENABLE_LIMIT {
            guard.check(true, || true, start);
        }
        let later = start + REENABLE_WINDOW;
        assert_eq!(guard.check(true, || true, later), Verdict::Reenable);
    }
}
