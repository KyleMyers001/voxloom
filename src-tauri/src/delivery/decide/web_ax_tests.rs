use super::*;

#[test]
fn wait_stops_at_first_found() {
    let mut reads = 0;
    let mut waits = 0;
    let r: Result<u8, &str> = wait_for_focus(
        || {
            reads += 1;
            if reads < 3 {
                Read::Retry("container")
            } else {
                Read::Found(7)
            }
        },
        || waits += 1,
    );
    assert_eq!(r, Ok(7));
    assert_eq!((reads, waits), (3, 2));
}

#[test]
fn wait_is_bounded_to_about_two_point_four_seconds() {
    let mut reads = 0;
    let mut waited_ms = 0;
    let r: Result<(), &str> = wait_for_focus(
        || {
            reads += 1;
            Read::Retry("container")
        },
        || waited_ms += BOOTSTRAP_WAIT_MS,
    );
    assert_eq!(r, Err("container"));
    assert_eq!(reads, BOOTSTRAP_READS);
    assert!(waited_ms <= 2_400);
    // Chromium/Electron debounce activation for two seconds.
    assert!(waited_ms >= 2_000);
}

#[test]
fn foreground_change_aborts_immediately_without_waiting() {
    let mut waits = 0;
    let r: Result<(), &str> = wait_for_focus(|| Read::Abort("foreground changed"), || waits += 1);
    assert_eq!(r, Err("foreground changed"));
    assert_eq!(waits, 0);
}

#[test]
fn bootstrap_requires_trust_known_host_and_matching_frontmost_pid() {
    assert!(bootstrap_allowed(true, true, Some(42), None));
    assert!(bootstrap_allowed(true, true, Some(42), Some(42)));
    assert!(!bootstrap_allowed(false, true, Some(42), None));
    assert!(!bootstrap_allowed(true, false, Some(42), None));
    assert!(!bootstrap_allowed(true, true, None, None));
    assert!(!bootstrap_allowed(true, true, Some(0), None));
    assert!(!bootstrap_allowed(true, true, Some(42), Some(43)));
}

#[test]
fn only_containers_or_missing_focus_need_web_ax() {
    assert!(needs_web_ax(None));
    assert!(needs_web_ax(Some("AXWebArea")));
    assert!(needs_web_ax(Some("AXGroup")));
    assert!(!needs_web_ax(Some("AXTextField")));
    assert!(!needs_web_ax(Some("AXSecureTextField")));
}

#[test]
fn reassert_runs_on_every_attempt_for_the_same_pid() {
    // Regression: a per-pid "already enabled" cache skipped this after the
    // first success, so an app that later dropped accessibility stayed broken.
    let mut sets = Vec::new();
    for _ in 0..3 {
        assert!(reassert_with(
            Some(42),
            Some("AXEnhancedUserInterface"),
            true,
            |pid, a| {
                sets.push((pid, a));
                true
            }
        ));
    }
    assert_eq!(sets, vec![(42, "AXEnhancedUserInterface"); 3]);
}

#[test]
fn reassert_skips_unknown_hosts_invalid_pids_and_untrusted() {
    let never = |_: i32, _: &str| -> bool { panic!("must not touch AX") };
    assert!(!reassert_with(Some(42), None::<&str>, true, never));
    assert!(!reassert_with(None, Some("x"), true, never));
    assert!(!reassert_with(Some(0), Some("x"), true, never));
    assert!(!reassert_with(Some(-1), Some("x"), true, never));
    assert!(!reassert_with(Some(42), Some("x"), false, never));
}

#[test]
fn failed_reassert_is_reported_and_retried_next_time() {
    let mut calls = 0;
    let mut set = |_: i32, _: &str| {
        calls += 1;
        calls > 1
    };
    assert!(!reassert_with(
        Some(7),
        Some("AXManualAccessibility"),
        true,
        &mut set
    ));
    assert!(reassert_with(
        Some(7),
        Some("AXManualAccessibility"),
        true,
        &mut set
    ));
    assert_eq!(calls, 2);
}

fn ids(window_doc: Option<&str>, area_url: Option<&str>) -> DocIds {
    DocIds {
        window_doc: window_doc.map(Into::into),
        area_url: area_url.map(Into::into),
        window_title: Some("Inbox - Gmail".into()),
    }
}

#[test]
fn context_requires_the_same_focused_window() {
    let a = ids(Some("https://a/"), None);
    assert!(context_holds(Some(true), &a, &a, false));
    assert!(!context_holds(Some(false), &a, &a, false), "window switch");
    assert!(!context_holds(None, &a, &a, false), "window unreadable");
}

#[test]
fn tab_switch_in_the_same_window_aborts() {
    let start = ids(Some("https://a/"), Some("https://a/"));
    let tab = ids(Some("https://b/"), None);
    assert!(!context_holds(Some(true), &start, &tab, false));
    let tab_area = ids(Some("https://a/"), Some("https://b/"));
    assert!(!context_holds(Some(true), &start, &tab_area, true));
}

#[test]
fn found_field_must_be_in_the_captured_web_area() {
    let start = ids(None, Some("https://a/"));
    assert!(context_holds(
        Some(true),
        &start,
        &ids(None, Some("https://a/")),
        true
    ));
    assert!(!context_holds(Some(true), &start, &ids(None, None), true));
    // While polling, an unknown area URL is fine (tree still coming up).
    assert!(context_holds(Some(true), &start, &ids(None, None), false));
}

#[test]
fn window_document_alone_suffices_when_area_url_unknown_at_completion() {
    let start = ids(Some("https://a/"), None);
    assert!(context_holds(
        Some(true),
        &start,
        &ids(Some("https://a/"), Some("https://x/")),
        true
    ));
    assert!(!context_holds(
        Some(true),
        &start,
        &ids(None, Some("https://a/")),
        true
    ));
}

#[test]
fn no_page_identity_at_completion_refuses_the_late_target() {
    let none = DocIds::default();
    assert!(!context_holds(Some(true), &none, &none, false));
    assert!(!context_holds(Some(true), &none, &none, true));
    let titled = DocIds {
        window_title: Some("Inbox".into()),
        ..DocIds::default()
    };
    assert!(!context_holds(Some(true), &titled, &titled, true));
}

#[test]
fn title_change_in_the_same_window_aborts() {
    // Chrome tab switch: same window element, URL/doc may lag; title changes.
    let start = ids(Some("https://a/"), Some("https://a/"));
    let mut now = start.clone();
    now.window_title = Some("Other tab".into());
    assert!(!context_holds(Some(true), &start, &now, false));
    assert!(!context_holds(Some(true), &start, &now, true));
    now.window_title = None;
    assert!(!context_holds(Some(true), &start, &now, false));
}

#[test]
fn same_pid_field_found_after_context_change_is_rejected_by_the_wait() {
    // Simulate the wait: polls 1-2 retry, then the user switches tab (abort).
    let start = ids(Some("https://a/"), None);
    let polls = [ids(Some("https://a/"), None), ids(Some("https://b/"), None)];
    let mut i = 0;
    let r: Result<u8, &str> = wait_for_focus(
        || {
            let now = &polls[i.min(1)];
            i += 1;
            if !context_holds(Some(true), &start, now, false) {
                Read::Abort("context changed")
            } else if i < 3 {
                Read::Retry("not yet")
            } else {
                Read::Found(1)
            }
        },
        || {},
    );
    assert_eq!(r, Err("context changed"));
}
