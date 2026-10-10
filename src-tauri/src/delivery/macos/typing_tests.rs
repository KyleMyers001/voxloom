use super::*;
use std::cell::{Cell, RefCell};

#[derive(Clone, Debug, PartialEq)]
enum Call {
    Source(i32),
    Keyboard(usize, u16, bool, usize),
    Unicode(usize, Vec<u16>),
    Flags(usize, u64),
    Post(u32, usize),
    Release(usize),
    Focus,
    Access(bool),
    Confirm(String),
}
#[derive(Default)]
struct FakeEvents {
    calls: RefCell<Vec<Call>>,
    fail_source: bool,
    deny_access_at: usize,
    access_checks: Cell<usize>,
    fail_event: usize,
    allocations: Cell<usize>,
}
impl FakeEvents {
    fn record(&self, call: Call) {
        self.calls.borrow_mut().push(call);
    }
    fn posted(&self) -> usize {
        self.calls
            .borrow()
            .iter()
            .filter(|c| matches!(c, Call::Post(..)))
            .count()
    }
    fn assert_released(&self) {
        let calls = self.calls.borrow();
        let mut source_live = false;
        let mut events = std::collections::HashSet::new();
        let mut allocated = std::collections::HashSet::new();
        for call in calls.iter() {
            match call {
                Call::Source(_) if !self.fail_source => {
                    assert!(allocated.insert(1), "source allocated twice: {calls:?}");
                    source_live = true;
                }
                Call::Keyboard(source, _, _, id) => {
                    assert!(source_live && *source == 1, "dead source used: {calls:?}");
                    if *id != 0 {
                        assert!(allocated.insert(*id), "handle reused: {calls:?}");
                        events.insert(*id);
                    }
                }
                Call::Unicode(id, _) | Call::Flags(id, _) | Call::Post(_, id) => {
                    assert!(events.contains(id), "dead event {id} used: {calls:?}");
                }
                Call::Release(1) => {
                    assert!(source_live, "unknown or double source release: {calls:?}");
                    // Preserve the implementation's conservative lifetime even if
                    // CoreGraphics internally retains a source for its events.
                    assert!(
                        events.is_empty(),
                        "source released before events: {calls:?}"
                    );
                    source_live = false;
                }
                Call::Release(id) => {
                    assert!(
                        *id != 0 && events.remove(id),
                        "null, unknown or double event release {id}: {calls:?}"
                    );
                }
                _ => {}
            }
        }
        assert!(
            !source_live && events.is_empty(),
            "leaked handles: {calls:?}"
        );
    }
}
impl Events for FakeEvents {
    fn post_access(&self) -> bool {
        let n = self.access_checks.get() + 1;
        self.access_checks.set(n);
        let allowed = n != self.deny_access_at;
        self.record(Call::Access(allowed));
        allowed
    }
    fn source(&self, state: i32) -> CFTypeRef {
        self.record(Call::Source(state));
        if self.fail_source {
            std::ptr::null()
        } else {
            1usize as CFTypeRef
        }
    }
    fn keyboard(&self, source: CFTypeRef, keycode: u16, down: bool) -> CFTypeRef {
        let n = self.allocations.get() + 1;
        self.allocations.set(n);
        let id = if n == self.fail_event { 0 } else { n + 1 };
        self.record(Call::Keyboard(source as usize, keycode, down, id));
        id as CFTypeRef
    }
    fn unicode(&self, event: CFTypeRef, units: &[u16]) {
        self.record(Call::Unicode(event as usize, units.to_vec()));
    }
    fn flags(&self, event: CFTypeRef, flags: u64) {
        self.record(Call::Flags(event as usize, flags));
    }
    fn post(&self, tap: u32, event: CFTypeRef) {
        self.record(Call::Post(tap, event as usize));
    }
    fn release(&self, value: CFTypeRef) {
        self.record(Call::Release(value as usize));
    }
}

#[test]
fn ownership_spy_rejects_invalid_release_traces() {
    let api = FakeEvents::default();
    assert_eq!(
        type_text_with(&api, "hello", || Ok(()), |_| true),
        (1, Ok(()))
    );
    api.assert_released();
    let valid = api.calls.borrow().clone();
    let event_release = valid.iter().position(|c| *c == Call::Release(2)).unwrap();
    let first_use = valid
        .iter()
        .position(|c| matches!(c, Call::Unicode(..)))
        .unwrap();
    let mut early_event = valid.clone();
    early_event.remove(event_release);
    early_event.insert(first_use, Call::Release(2));
    let mut early_source = valid.clone();
    early_source.pop();
    early_source.insert(first_use, Call::Release(1));
    let mut cases = vec![
        ("dead event", early_event),
        ("source released before events", early_source),
    ];
    for id in [0, 99, 2] {
        let mut invalid = valid.clone();
        invalid.push(Call::Release(id));
        cases.push(("null, unknown or double event release", invalid));
    }
    let mut dead_source = valid.clone();
    dead_source.push(Call::Keyboard(1, 0, true, 4));
    cases.push(("dead source used", dead_source));
    for (expected, calls) in cases {
        let invalid = FakeEvents {
            calls: RefCell::new(calls),
            ..Default::default()
        };
        let panic =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| invalid.assert_released()))
                .expect_err("invalid ownership trace must be rejected");
        let message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(
            message.contains(expected),
            "expected {expected:?}, got {message:?}"
        );
    }
}

#[test]
fn null_private_source_fails_before_focus_or_event_allocation() {
    let api = FakeEvents {
        fail_source: true,
        ..Default::default()
    };
    let (posted, result) = type_text_with(
        &api,
        "hello",
        || {
            api.record(Call::Focus);
            Ok(())
        },
        |_| true,
    );
    assert_eq!(posted, 0);
    assert_eq!(result, Err("could not create private event source".into()));
    assert_eq!(*api.calls.borrow(), [Call::Source(-1)]);
    let terminal = FakeEvents {
        fail_source: true,
        ..Default::default()
    };
    let result = type_terminal_with(
        &terminal,
        "hello",
        || {
            terminal.record(Call::Focus);
            Ok(())
        },
        || panic!("no pacing without a source"),
    );
    assert_eq!(result.unwrap_err(), "could not create private event source");
    assert_eq!(*terminal.calls.borrow(), [Call::Source(-1)]);
}

#[test]
fn failed_key_pair_allocation_never_posts_or_confirms_and_releases_survivor() {
    for fail_event in [1, 2] {
        let api = FakeEvents {
            fail_event,
            ..Default::default()
        };
        let (posted, result) =
            type_text_with(&api, "hello", || Ok(()), |_| panic!("no pair posted"));
        assert_eq!(posted, 0);
        assert_eq!(result, Err("could not create key events".into()));
        assert_eq!(api.posted(), 0);
        api.assert_released();
    }
}

#[test]
fn transport_uses_private_source_unicode_zero_flags_and_down_up_order() {
    let api = FakeEvents::default();
    let text = "café 日本🙂";
    assert_eq!(
        type_text_with(
            &api,
            text,
            || {
                api.record(Call::Focus);
                Ok(())
            },
            |s| {
                api.record(Call::Confirm(s.into()));
                true
            }
        ),
        (1, Ok(()))
    );
    assert_eq!(
        *api.calls.borrow(),
        [
            Call::Source(-1),
            Call::Focus,
            Call::Keyboard(1, 0, true, 2),
            Call::Keyboard(1, 0, false, 3),
            Call::Unicode(2, text.encode_utf16().collect()),
            Call::Flags(2, 0),
            Call::Flags(3, 0),
            Call::Post(0, 2),
            Call::Post(0, 3),
            Call::Release(3),
            Call::Release(2),
            Call::Confirm(text.into()),
            Call::Release(1),
        ]
    );
    api.assert_released();
}

#[test]
fn focus_loss_before_first_or_later_chunk_stops_without_redirect_or_confirmation() {
    for allowed in [0, 1] {
        let api = FakeEvents::default();
        let checks = Cell::new(0);
        let confirmations = Cell::new(0);
        let (posted, result) = type_text_with(
            &api,
            &"x".repeat(KEY_EVENT_UTF16_MAX * 3),
            || {
                let n = checks.get();
                checks.set(n + 1);
                if n == allowed {
                    Err("target changed".into())
                } else {
                    Ok(())
                }
            },
            |_| {
                confirmations.set(confirmations.get() + 1);
                true
            },
        );
        assert_eq!(posted, allowed);
        assert_eq!(api.posted(), allowed * 2);
        assert_eq!(result, Err("target changed".into()));
        assert_eq!(checks.get(), allowed + 1);
        assert_eq!(confirmations.get(), allowed);
        api.assert_released();
    }
}

#[test]
fn unconfirmed_first_chunk_stops_with_honest_posted_count() {
    let api = FakeEvents::default();
    let confirmed = RefCell::new(Vec::new());
    let (posted, result) = type_text_with(
        &api,
        &"x".repeat(KEY_EVENT_UTF16_MAX * 3),
        || Ok(()),
        |s| {
            confirmed.borrow_mut().push(s.to_string());
            false
        },
    );
    assert_eq!(posted, 1);
    assert!(result.unwrap_err().contains("not confirmed"));
    assert_eq!(api.posted(), 2);
    assert_eq!(*confirmed.borrow(), ["x".repeat(KEY_EVENT_UTF16_MAX)]);
    api.assert_released();
}

#[test]
fn later_allocation_failure_preserves_partial_count_and_does_not_confirm_failed_chunk() {
    let api = FakeEvents {
        fail_event: 4,
        ..Default::default()
    };
    let confirmations = Cell::new(0);
    let (posted, result) = type_text_with(
        &api,
        &"x".repeat(KEY_EVENT_UTF16_MAX * 3),
        || Ok(()),
        |_| {
            confirmations.set(confirmations.get() + 1);
            true
        },
    );
    assert_eq!(posted, 1);
    assert!(result.is_err());
    assert_eq!(api.posted(), 2);
    assert_eq!(confirmations.get(), 1);
    assert_eq!(api.allocations.get(), 4);
    api.assert_released();
}

#[test]
fn each_confirmation_is_cumulative_and_never_splits_a_surrogate_pair() {
    let api = FakeEvents::default();
    let text = format!(
        "{}🙂日本語{}",
        "a".repeat(KEY_EVENT_UTF16_MAX - 1),
        "z".repeat(KEY_EVENT_UTF16_MAX)
    );
    let confirmed = RefCell::new(Vec::new());
    let (_, result) = type_text_with(
        &api,
        &text,
        || Ok(()),
        |s| {
            confirmed.borrow_mut().push(s.to_string());
            true
        },
    );
    assert!(result.is_ok());
    let calls = api.calls.borrow();
    let chunks: Vec<_> = calls
        .iter()
        .filter_map(|c| match c {
            Call::Unicode(_, c) => Some(c),
            _ => None,
        })
        .collect();
    assert!(chunks.len() > 1);
    let mut sent = String::new();
    for (chunk, actual) in chunks.iter().zip(confirmed.borrow().iter()) {
        assert!(chunk.len() <= KEY_EVENT_UTF16_MAX);
        sent.push_str(&String::from_utf16(chunk).expect("complete surrogate pairs"));
        assert_eq!(&sent, actual);
    }
    assert_eq!(sent, text);
    assert_eq!(chunks.len(), confirmed.borrow().len());
    api.assert_released();
}

#[test]
fn terminal_permission_loss_is_checked_before_focus_and_reports_only_posted_pairs() {
    use crate::delivery::decide::report::TerminalDispatch;
    for deny_access_at in [1, 2] {
        let api = FakeEvents {
            deny_access_at,
            ..Default::default()
        };
        let paced = Cell::new(0);
        let result = type_terminal_with(
            &api,
            &"x".repeat(KEY_EVENT_UTF16_MAX * 3),
            || {
                api.record(Call::Focus);
                Ok(())
            },
            || paced.set(paced.get() + 1),
        );
        if deny_access_at == 1 {
            assert_eq!(
                result.unwrap_err(),
                "Terminal event-posting permission denied"
            );
        } else {
            let report = result.unwrap();
            assert!(report.typed && report.unverified);
            assert_eq!(report.terminal_dispatch, Some(TerminalDispatch::Partial));
        }
        let pairs = deny_access_at - 1;
        assert_eq!(api.posted(), pairs * 2);
        assert_eq!(paced.get(), pairs);
        assert_eq!(
            api.calls
                .borrow()
                .iter()
                .filter(|c| **c == Call::Focus)
                .count(),
            pairs
        );
        assert_eq!(api.access_checks.get(), deny_access_at);
        api.assert_released();
    }
}

#[test]
fn terminal_unsafe_suffix_is_rejected_before_permission_focus_or_event_work() {
    let api = FakeEvents::default();
    let result = type_terminal_with(
        &api,
        &format!("{}\n", "x".repeat(KEY_EVENT_UTF16_MAX * 3)),
        || panic!("no focus lookup for unsafe payload"),
        || panic!("no pacing"),
    );
    assert!(result.unwrap_err().contains("control or line separator"));
    assert_eq!(*api.calls.borrow(), [Call::Source(-1), Call::Release(1)]);
}

#[test]
fn terminal_event_allocation_failure_is_not_reported_as_complete_or_retried() {
    use crate::delivery::decide::report::TerminalDispatch;
    for fail_event in [2, 4] {
        let api = FakeEvents {
            fail_event,
            ..Default::default()
        };
        let result =
            type_terminal_with(&api, &"x".repeat(KEY_EVENT_UTF16_MAX * 3), || Ok(()), || {});
        if fail_event == 2 {
            assert_eq!(result.unwrap_err(), "could not create key events");
        } else {
            let report = result.unwrap();
            assert!(report.typed && report.unverified);
            assert_eq!(report.terminal_dispatch, Some(TerminalDispatch::Partial));
        }
        assert_eq!(api.allocations.get(), fail_event);
        assert_eq!(api.posted(), fail_event - 2);
        api.assert_released();
    }
}

#[test]
fn terminal_callback_panic_releases_private_source() {
    let api = FakeEvents::default();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = type_terminal_with(&api, "hello", || panic!("focus panic"), || {});
    }));
    assert!(result.is_err());
    api.assert_released();
}

#[test]
fn callback_panic_releases_private_source() {
    let api = FakeEvents::default();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = type_text_with(&api, "hello", || Ok(()), |_| panic!("read-back panic"));
    }));
    assert!(result.is_err());
    api.assert_released();
}
