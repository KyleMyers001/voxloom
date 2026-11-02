use super::*;

#[test]
fn picks_frontmost_pid_but_never_self_or_none() {
    assert_eq!(fallback_pid(Some(42), 7), Ok(42));
    assert_eq!(fallback_pid(Some(7), 7), Err(FallbackError::SelfFrontmost));
    assert_eq!(fallback_pid(None, 7), Err(FallbackError::NoFrontmost));
}

#[test]
fn accepts_only_clean_element_owned_by_frontmost() {
    assert_eq!(accept_element(0, false, Some(42), 42), Ok(()));
    assert_eq!(
        accept_element(-25212, true, None, 42),
        Err(FallbackError::AppFocus(-25212, true))
    );
    assert_eq!(
        accept_element(0, true, None, 42),
        Err(FallbackError::AppFocus(0, true))
    );
    assert_eq!(
        accept_element(0, false, Some(9), 42),
        Err(FallbackError::PidMismatch)
    );
    assert_eq!(
        accept_element(0, false, None, 42),
        Err(FallbackError::PidMismatch)
    );
}

#[test]
fn retry_is_short_and_starts_immediately() {
    assert_eq!(FALLBACK_RETRY_MS[0], 0);
    let total: u64 = FALLBACK_RETRY_MS.iter().sum();
    assert!((50..=150).contains(&total));
}

#[test]
fn activation_lengthens_retry_but_stays_bounded() {
    assert_eq!(retry_schedule(false), &FALLBACK_RETRY_MS);
    let total: u64 = retry_schedule(true).iter().sum();
    assert_eq!(retry_schedule(true)[0], 0);
    assert!((150..=600).contains(&total));
}

#[test]
fn trace_lists_every_step_with_codes() {
    let base = "Accessibility focus unavailable at delivery validation (x)";
    let steps = [
        Step::Activate(Some(("AXManualAccessibility", 0))),
        Step::AppFocus {
            tries: 5,
            err: -25212,
            null: true,
        },
        Step::Walk {
            window: "AXFocusedWindow",
            err: -25212,
            outcome: None,
        },
        Step::Walk {
            window: "AXMainWindow",
            err: 0,
            outcome: Some("no focused field in 9 nodes".into()),
        },
    ];
    let msg = with_fallback_trace(base, Some(66707), &steps);
    assert_eq!(
        msg,
        format!(
            "{base}; frontmost fallback pid=66707: AXManualAccessibility set=0; \
             app AXFocusedUIElement=-25212 (null) x5; walk AXFocusedWindow=-25212; \
             walk AXMainWindow: no focused field in 9 nodes"
        )
    );
    let msg = with_fallback_trace(base, None, &[Step::Activate(None)]);
    assert!(msg.ends_with("pid=none: activation n/a (not Electron/Chromium)"));
}

#[test]
fn failure_keeps_original_message_and_adds_fallback_code() {
    let base = "Accessibility focus unavailable at delivery validation (AX trusted=yes; \
                AXFocusedApplication=-25212; AXFocusedUIElement=-25212 (null))";
    let msg = with_fallback_error(base, Some(42), &FallbackError::AppFocus(-25204, false));
    assert!(msg.starts_with(base));
    assert!(msg.ends_with("frontmost fallback pid=42: app AXFocusedUIElement=-25204"));
    let msg = with_fallback_error(base, Some(7), &FallbackError::SelfFrontmost);
    assert!(msg.contains("frontmost app is Voxloom"));
    let msg = with_fallback_error(base, None, &FallbackError::NoFrontmost);
    assert!(msg.contains("pid=none: no frontmost app"));
}

#[test]
fn refuses_when_frontmost_changed_after_read() {
    assert_eq!(still_frontmost(42, Some(42)), Ok(()));
    assert_eq!(
        still_frontmost(42, Some(9)),
        Err(FallbackError::FrontmostChanged)
    );
    assert_eq!(
        still_frontmost(42, None),
        Err(FallbackError::FrontmostChanged)
    );
    let msg = with_fallback_error("base", Some(42), &FallbackError::FrontmostChanged);
    assert_eq!(
        msg,
        "base; frontmost fallback pid=42: frontmost app changed during AX read"
    );
}
