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

#[test]
fn lost_access_tears_down_even_when_the_tap_was_not_disabled() {
    let mut guard = TapGuard::default();
    let now = Instant::now();
    assert_eq!(
        guard.check(Disables::default(), false, now),
        Verdict::TearDown
    );
    assert_eq!(guard.check(user_input(), false, now), Verdict::TearDown);
}

#[test]
fn a_running_tap_with_access_is_kept() {
    let mut guard = TapGuard::default();
    assert_eq!(
        guard.check(Disables::default(), true, Instant::now()),
        Verdict::Keep
    );
}

#[test]
fn a_disabled_tap_is_reenabled_only_with_access() {
    let mut guard = TapGuard::default();
    assert_eq!(
        guard.check(user_input(), true, Instant::now()),
        Verdict::Reenable
    );
    assert_eq!(
        guard.check(timeout(), true, Instant::now()),
        Verdict::Reenable
    );
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
    let start = Instant::now();
    for i in 0..REENABLE_LIMIT {
        let at = start + Duration::from_secs(i as u64);
        assert_eq!(
            guard.check(user_input(), true, at),
            Verdict::Reenable,
            "{i}"
        );
    }
    let at = start + Duration::from_secs(9);
    assert_eq!(guard.check(user_input(), true, at), Verdict::TearDown);
}

#[test]
fn re_enables_older_than_the_window_free_the_budget() {
    let mut guard = TapGuard::default();
    let start = Instant::now();
    for _ in 0..REENABLE_LIMIT {
        guard.check(user_input(), true, start);
    }
    let later = start + REENABLE_WINDOW;
    assert_eq!(guard.check(user_input(), true, later), Verdict::Reenable);
}

#[test]
fn a_second_timeout_soon_after_the_first_fails_closed() {
    let mut guard = TapGuard::default();
    let start = Instant::now();
    assert_eq!(guard.check(timeout(), true, start), Verdict::Reenable);
    let soon = start + TIMEOUT_REPEAT_WINDOW - Duration::from_millis(1);
    assert_eq!(guard.check(timeout(), true, soon), Verdict::TearDown);
}

#[test]
fn two_timeouts_in_one_slice_fail_closed() {
    let mut guard = TapGuard::default();
    let both = Disables {
        timeouts: 2,
        user_input: 0,
    };
    assert_eq!(guard.check(both, true, Instant::now()), Verdict::TearDown);
}

#[test]
fn timeouts_far_apart_are_each_reenabled() {
    let mut guard = TapGuard::default();
    let start = Instant::now();
    assert_eq!(guard.check(timeout(), true, start), Verdict::Reenable);
    let later = start + TIMEOUT_REPEAT_WINDOW;
    assert_eq!(guard.check(timeout(), true, later), Verdict::Reenable);
}

#[test]
fn user_input_disables_do_not_count_as_timeouts() {
    let mut guard = TapGuard::default();
    let start = Instant::now();
    assert_eq!(guard.check(user_input(), true, start), Verdict::Reenable);
    let soon = start + Duration::from_millis(10);
    assert_eq!(guard.check(timeout(), true, soon), Verdict::Reenable);
}
