use super::*;

fn timeout() -> Disables {
    Disables {
        timeouts: 1,
        user_input: 0,
    }
}

fn user_input() -> Disables {
    Disables {
        timeouts: 0,
        user_input: 1,
    }
}

fn none() -> Disables {
    Disables::default()
}

/// Published after `checks` checks, every one of which found access.
fn granted(checks: u64) -> Access {
    Access {
        trusted: true,
        started: checks,
        granted: checks,
    }
}

/// Published once check `checks` found access lost.
fn lost(checks: u64) -> Access {
    Access {
        trusted: false,
        started: checks,
        granted: checks - 1,
    }
}

/// A disable seen after `checks` checks, then the watchdog's look once the
/// next check passed. Returns the first decision that is not a wait.
fn disable_then_check(
    guard: &mut TapGuard,
    disables: Disables,
    checks: &mut u64,
    at: Instant,
) -> Verdict {
    let first = guard.check(disables, granted(*checks), at);
    if first != Verdict::AwaitCheck {
        return first;
    }
    *checks += 1;
    guard.check(none(), granted(*checks), at)
}

#[test]
fn lost_access_tears_down_even_when_the_tap_was_not_disabled() {
    let mut guard = TapGuard::default();
    let now = Instant::now();
    assert_eq!(guard.check(none(), lost(1), now), Verdict::TearDown);
    assert_eq!(guard.check(user_input(), lost(1), now), Verdict::TearDown);
}

#[test]
fn a_running_tap_with_access_is_kept() {
    let mut guard = TapGuard::default();
    assert_eq!(
        guard.check(none(), granted(1), Instant::now()),
        Verdict::Keep
    );
}

#[test]
fn a_disable_right_after_a_revoke_is_not_reenabled_on_the_stale_flag() {
    // Check 4 passed, then Accessibility was revoked and macOS disabled the
    // tap before any check saw the revoke: `trusted` still reads true.
    let mut guard = TapGuard::default();
    let now = Instant::now();
    for disables in [user_input(), user_input(), user_input(), timeout()] {
        assert_eq!(guard.check(disables, granted(4), now), Verdict::AwaitCheck);
    }
    let in_flight = Access {
        trusted: true,
        started: 5,
        granted: 4,
    };
    assert_eq!(guard.check(none(), in_flight, now), Verdict::AwaitCheck);
    // The first check that started after the disable finds the loss.
    assert_eq!(guard.check(none(), lost(5), now), Verdict::TearDown);
}

#[test]
fn a_disabled_tap_is_reenabled_once_a_check_started_after_the_disable_passes() {
    let mut guard = TapGuard::default();
    let now = Instant::now();
    // Check 4 was running when the disable was seen.
    let running = Access {
        trusted: true,
        started: 4,
        granted: 3,
    };
    assert_eq!(guard.check(user_input(), running, now), Verdict::AwaitCheck);
    // It passes, but it started before the disable: it doesn't count.
    assert_eq!(guard.check(none(), granted(4), now), Verdict::AwaitCheck);
    // Check 5 started after the disable and passes.
    assert_eq!(guard.check(none(), granted(5), now), Verdict::Reenable);
    assert_eq!(guard.check(none(), granted(5), now), Verdict::Keep);
}

#[test]
fn note_counts_each_kind_of_disable() {
    let mut disables = Disables::default();
    disables.note(true);
    disables.note(false);
    disables.note(true);
    assert_eq!(
        disables,
        Disables {
            timeouts: 2,
            user_input: 1
        }
    );
}

#[test]
fn past_the_budget_of_three_a_disabled_tap_fails_closed() {
    assert_eq!(REENABLE_LIMIT, 3);
    let mut guard = TapGuard::default();
    let mut checks = 1;
    let start = Instant::now();
    for i in 0..REENABLE_LIMIT {
        let at = start + Duration::from_secs(i as u64);
        assert_eq!(
            disable_then_check(&mut guard, user_input(), &mut checks, at),
            Verdict::Reenable,
            "{i}"
        );
    }
    let at = start + Duration::from_secs(9);
    assert_eq!(
        disable_then_check(&mut guard, user_input(), &mut checks, at),
        Verdict::TearDown
    );
}

#[test]
fn re_enables_older_than_the_window_free_the_budget() {
    let mut guard = TapGuard::default();
    let mut checks = 1;
    let start = Instant::now();
    for _ in 0..REENABLE_LIMIT {
        disable_then_check(&mut guard, user_input(), &mut checks, start);
    }
    let later = start + REENABLE_WINDOW;
    assert_eq!(
        disable_then_check(&mut guard, user_input(), &mut checks, later),
        Verdict::Reenable
    );
}

#[test]
fn a_second_timeout_soon_after_the_first_fails_closed() {
    let mut guard = TapGuard::default();
    let mut checks = 1;
    let start = Instant::now();
    assert_eq!(
        disable_then_check(&mut guard, timeout(), &mut checks, start),
        Verdict::Reenable
    );
    let soon = start + TIMEOUT_REPEAT_WINDOW - Duration::from_millis(1);
    // Decided at once: no check can make a repeat timeout worth fighting.
    assert_eq!(
        guard.check(timeout(), granted(checks), soon),
        Verdict::TearDown
    );
}

#[test]
fn two_timeouts_in_one_slice_fail_closed() {
    let mut guard = TapGuard::default();
    let both = Disables {
        timeouts: 2,
        user_input: 0,
    };
    assert_eq!(
        guard.check(both, granted(1), Instant::now()),
        Verdict::TearDown
    );
}

#[test]
fn timeouts_far_apart_are_each_reenabled() {
    let mut guard = TapGuard::default();
    let mut checks = 1;
    let start = Instant::now();
    assert_eq!(
        disable_then_check(&mut guard, timeout(), &mut checks, start),
        Verdict::Reenable
    );
    let later = start + TIMEOUT_REPEAT_WINDOW;
    assert_eq!(
        disable_then_check(&mut guard, timeout(), &mut checks, later),
        Verdict::Reenable
    );
}

#[test]
fn user_input_disables_do_not_count_as_timeouts() {
    let mut guard = TapGuard::default();
    let mut checks = 1;
    let start = Instant::now();
    assert_eq!(
        disable_then_check(&mut guard, user_input(), &mut checks, start),
        Verdict::Reenable
    );
    let soon = start + Duration::from_millis(10);
    assert_eq!(
        disable_then_check(&mut guard, timeout(), &mut checks, soon),
        Verdict::Reenable
    );
}
