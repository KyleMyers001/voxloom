//! The shared cleanup budget, native side (BUS-16 3c-2c). The renderer owns
//! the budget (src/services/cleanup/budget.ts): it times the lease and the
//! run and falls back to the raw text when time is up. Here the run's time
//! left becomes a deadline when `cleanup_run` arrives, so the model re-hash
//! before the worker starts counts against it, and the worker gets what is
//! left to cap its reply.

use std::time::{Duration, Instant};

/// Must equal `CLEANUP_BUDGET_MS` in src/services/cleanup/budget.ts.
pub const CLEANUP_BUDGET: Duration = Duration::from_millis(10_000);

/// The worker timeout is only a backstop. It starts when the worker is
/// spawned, after the renderer's budget started, so with this grace the
/// renderer's timeout (and its 1 s cancel grace) always ends a slow run
/// first and reports `timeout`.
pub const BACKSTOP_GRACE: Duration = Duration::from_secs(2);

pub const WORKER_TIMEOUT: Duration = Duration::from_millis(12_000);

/// When the run must be done, from the renderer's time left on arrival.
/// Clamped to the budget, so a bad value cannot widen it.
pub fn run_deadline(time_left_ms: Option<u64>, now: Instant) -> Option<Instant> {
    let left = Duration::from_millis(time_left_ms?).min(CLEANUP_BUDGET);
    Some(now + left)
}

/// What is left for the worker, in whole milliseconds (0 once past).
pub fn time_left_ms(deadline: Option<Instant>, now: Instant) -> Option<u64> {
    let left = deadline?.saturating_duration_since(now);
    Some(u64::try_from(left.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backstop_is_the_budget_plus_grace() {
        assert_eq!(WORKER_TIMEOUT, CLEANUP_BUDGET + BACKSTOP_GRACE);
        // Longer than the renderer's budget plus its 1 s cancel grace.
        assert!(WORKER_TIMEOUT > CLEANUP_BUDGET + Duration::from_secs(1));
    }

    #[test]
    fn the_budget_matches_the_renderer() {
        let renderer = include_str!("../../../src/services/cleanup/budget.ts");
        assert!(renderer.contains("export const CLEANUP_BUDGET_MS = 10_000;"));
        assert_eq!(CLEANUP_BUDGET.as_millis(), 10_000);
    }

    #[test]
    fn the_re_hash_comes_out_of_the_run_time_left() {
        let arrived = Instant::now();
        let deadline = run_deadline(Some(7_000), arrived);
        // A 2.5 s re-hash before the worker starts leaves it 4.5 s.
        let spawned = arrived + Duration::from_millis(2_500);
        assert_eq!(time_left_ms(deadline, spawned), Some(4_500));
        assert_eq!(
            time_left_ms(deadline, arrived + Duration::from_secs(9)),
            Some(0)
        );
    }

    #[test]
    fn time_left_is_clamped_to_the_budget_and_optional() {
        let now = Instant::now();
        assert_eq!(
            run_deadline(Some(u64::MAX), now),
            Some(now + CLEANUP_BUDGET)
        );
        assert_eq!(run_deadline(None, now), None);
        assert_eq!(time_left_ms(None, now), None);
    }
}
