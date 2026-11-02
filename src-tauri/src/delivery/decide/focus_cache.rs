//! Per-delivery warm state for the frontmost-app focus fallback. The first
//! fallback in a delivery may activate web AX, retry (~0.5 s) and walk the
//! window; per-chunk typing checks must not repeat that. While warm (same pid,
//! recently resolved), re-check the cached element first and skip activation
//! and the long retry. The cache is cleared when the delivery ends or fails
//! (TTL is only a backstop). Fail closed: the cached element is only reused
//! if it is still AXFocused, owned by the same frontmost pid, and in the app's
//! current AXFocusedWindow; the caller then re-validates it against the
//! intended snapshot.

/// A delivery (validation + all chunks) finishes well within this.
pub const WARM_TTL_MS: i64 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Warm {
    pub pid: i32,
    pub at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    /// Re-check the cached element before anything else.
    pub try_cached: bool,
    /// Set the activation attribute (cold only).
    pub activate: bool,
    /// Use the long post-activation retry schedule.
    pub long_retry: bool,
}

pub fn is_warm(warm: Option<Warm>, pid: i32, now_ms: i64) -> bool {
    warm.is_some_and(|w| w.pid == pid && (0..=WARM_TTL_MS).contains(&(now_ms - w.at_ms)))
}

pub fn plan(warm: Option<Warm>, pid: i32, now_ms: i64) -> Plan {
    let hot = is_warm(warm, pid, now_ms);
    Plan {
        try_cached: hot,
        activate: !hot,
        long_retry: !hot,
    }
}

/// Cached element is reusable only if still focused and owned by `pid`,
/// which must still be frontmost, and its window is the app's focused window
/// (`same_window`: None = unreadable, treated as a miss).
pub fn cached_ok(
    focused: bool,
    owner: Option<i32>,
    front: Option<i32>,
    pid: i32,
    same_window: Option<bool>,
) -> bool {
    focused && owner == Some(pid) && front == Some(pid) && same_window == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: Option<Warm> = Some(Warm {
        pid: 42,
        at_ms: 1_000,
    });

    #[test]
    fn cold_does_full_fallback() {
        let cold = Plan {
            try_cached: false,
            activate: true,
            long_retry: true,
        };
        assert_eq!(plan(None, 42, 1_000), cold);
        assert_eq!(plan(W, 7, 1_100), cold, "other pid");
        assert_eq!(plan(W, 42, 1_000 + WARM_TTL_MS + 1), cold, "expired");
        assert_eq!(plan(W, 42, 999), cold, "clock went backwards");
    }

    #[test]
    fn warm_skips_activation_and_long_retry() {
        let hot = Plan {
            try_cached: true,
            activate: false,
            long_retry: false,
        };
        assert_eq!(plan(W, 42, 1_000), hot);
        assert_eq!(plan(W, 42, 1_000 + WARM_TTL_MS), hot);
    }

    #[test]
    fn cached_element_needs_focus_owner_and_frontmost() {
        assert!(cached_ok(true, Some(42), Some(42), 42, Some(true)));
        assert!(!cached_ok(false, Some(42), Some(42), 42, Some(true)));
        assert!(!cached_ok(true, Some(7), Some(42), 42, Some(true)));
        assert!(!cached_ok(true, None, Some(42), 42, Some(true)));
        assert!(!cached_ok(true, Some(42), Some(7), 42, Some(true)));
        assert!(!cached_ok(true, Some(42), None, 42, Some(true)));
    }

    #[test]
    fn cached_element_must_be_in_focused_window() {
        assert!(cached_ok(true, Some(42), Some(42), 42, Some(true)));
        assert!(!cached_ok(true, Some(42), Some(42), 42, Some(false)));
        assert!(!cached_ok(true, Some(42), Some(42), 42, None));
    }
}
