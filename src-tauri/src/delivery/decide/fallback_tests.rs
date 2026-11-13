use super::*;
use crate::delivery::decide::test_support::target;
use crate::delivery::decide::verify::{after_ax, AfterAx};
use crate::delivery::decide::{choose_insert_path, InsertPath};

const SECRET_TEXT: &str = "dictated secret phrase";
const SECRET_FIELD: &str = "confidential field body";

fn restored() -> PasteReport {
    PasteReport {
        clipboard_restored: true,
        restore_skipped_reason: None,
    }
}

#[test]
fn empty_and_attributed_values_are_readable_other_errors_are_not() {
    use ValueStatus::*;
    let cases = [
        (Ok(Some(String::new())), Text(String::new()), Some("")),
        // An attributed AXValue arrives here as its plain string.
        (Ok(Some("abc".into())), Text("abc".into()), Some("abc")),
        (Err(AX_ERROR_NO_VALUE), NoValue, Some("")),
        (Err(AX_NIL_VALUE), NoValue, Some("")),
        (Err(-25205), Unreadable(Some(-25205)), None),
        (Err(-25204), Unreadable(Some(-25204)), None),
        (Err(-25211), Unreadable(Some(-25211)), None),
        (Ok(None), Unreadable(None), None),
    ];
    for (read, status, text) in cases {
        let got = ValueStatus::from_read(read.clone());
        assert_eq!(got, status, "{read:?}");
        assert_eq!(got.text(), text, "{read:?}");
    }
    let field = ValueStatus::Text(SECRET_FIELD.into());
    assert_eq!(field.label(), "text");
    assert_eq!(ValueStatus::NoValue.label(), "no-value");
    assert_eq!(
        ValueStatus::Unreadable(Some(-25205)).label(),
        "unreadable(-25205)"
    );
}

#[test]
fn a_field_that_never_shows_a_value_proves_nothing_whatever_the_write_returned() {
    let none = ValueStatus::NoValue;
    assert_eq!(readback_text(&none, &none), None);
    let landed = ValueStatus::Text("hi".into());
    assert_eq!(readback_text(&none, &landed).as_deref(), Some("hi"));
    let empty = ValueStatus::Text(String::new());
    assert_eq!(readback_text(&empty, &none).as_deref(), Some(""));
    assert_eq!(readback_text(&empty, &ValueStatus::Unreadable(None)), None);
    // Even after an AX error: NoValue -> NoValue is Unverified, never Failed.
    let got = poll_readback(&none, || ValueStatus::NoValue, |_| {});
    assert_eq!(got, None);
    assert_eq!(
        after_ax(
            false,
            Err("AX set AXSelectedText failed (error -25205)".into()),
            "",
            got.as_deref(),
            "hi"
        ),
        AfterAx::Unverified
    );
}

#[test]
fn readback_polls_for_a_late_apply_and_stops_at_proof() {
    let before = ValueStatus::Text("ab".into());
    let mut reads = 0;
    let mut slept = Vec::new();
    let got = poll_readback(
        &before,
        || {
            reads += 1;
            ValueStatus::Text(if reads < 4 { "ab" } else { "abX" }.into())
        },
        |ms| slept.push(ms),
    );
    assert_eq!(got.as_deref(), Some("abX"));
    assert_eq!(reads, 4);
    assert_eq!(slept, [RETRY_READBACK_POLL_MS; 3]);
}

#[test]
fn readback_gives_up_after_about_600_ms_and_stays_strict() {
    let before = ValueStatus::Text("ab".into());
    let mut slept = 0;
    let got = poll_readback(&before, || ValueStatus::Text("ab".into()), |ms| slept += ms);
    assert_eq!(got.as_deref(), Some("ab"));
    assert!((300..=600).contains(&slept), "{slept}");
    // A partial landing never counts as proof.
    let partial = poll_readback(&before, || ValueStatus::Text("abX".into()), |_| {});
    assert_eq!(
        after_ax(false, Ok(()), "ab", partial.as_deref(), "XYZ"),
        AfterAx::Unverified
    );
}

#[test]
fn readback_latches_the_first_change_so_a_revert_cannot_read_as_unchanged() {
    let before = ValueStatus::Text("ab".into());
    let reads = ["ab", "abX", "ab", "ab"];
    let mut next = reads.iter();
    let mut slept = 0;
    let got = poll_readback(
        &before,
        || ValueStatus::Text(next.next().unwrap_or(&"ab").to_string()),
        |ms| slept += ms,
    );
    assert_eq!(got.as_deref(), Some("abX"));
    assert_eq!(slept, RETRY_READBACK_POLL_MS);
    // Changed but not proof: Unverified (no paste), never Failed.
    assert_eq!(
        after_ax(false, Ok(()), "ab", got.as_deref(), "XYZ"),
        AfterAx::Unverified
    );
    // An unreadable read is latched as unknown too.
    let mut reads = vec![ValueStatus::Unreadable(Some(-25204)), before.clone()].into_iter();
    let got = poll_readback(&before, || reads.next().unwrap(), |_| {});
    assert_eq!(got, None);
}

fn no_walk() -> Vec<String> {
    panic!("ancestors must not be walked")
}

#[test]
fn allowlisted_and_secure_roles_classify_as_before() {
    let settable = || EditFacts {
        value: true,
        ..Default::default()
    };
    for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"] {
        assert_eq!(
            classify_target(role, None, settable, no_walk),
            classify_role(role)
        );
    }
    let secure = classify_target("AXTextField", Some("AXSecureTextField"), settable, no_walk);
    assert_eq!(secure.0, "secure");
    for role in [
        "AXStaticText",
        "AXButton",
        "AXImage",
        "AXMenu",
        "AXCheckBox",
        "unknown",
    ] {
        assert!(!classify_target(role, None, settable, no_walk).1, "{role}");
    }
}

#[test]
fn editable_containers_and_unknown_roles_become_paste_only_targets() {
    let none: fn() -> Vec<String> = Vec::new;
    let settable = || EditFacts {
        selected_range: true,
        ..Default::default()
    };
    for role in [
        "AXWebArea",
        "AXGroup",
        "AXScrollArea",
        "AXDocument",
        "AXUnknown",
    ] {
        assert_eq!(
            classify_target(role, None, settable, none),
            ("insertable", true, None),
            "{role}"
        );
        assert!(
            !classify_target(role, None, EditFacts::default, none).1,
            "{role}"
        );
        // A paste-only target never takes an AX write.
        let mut snap = target("insertable", Some(1), Some("1:x:#1"));
        snap.element_role = Some(role.into());
        assert!(matches!(
            choose_insert_path(&snap, true),
            InsertPath::Refuse(_)
        ));
    }
}

#[test]
fn a_grid_selection_never_pastes_but_a_cell_editor_does() {
    let settable = || EditFacts {
        value: true,
        selected_text: true,
        selected_range: true,
    };
    let none: fn() -> Vec<String> = Vec::new;
    for role in [
        "AXTable",
        "AXGrid",
        "AXCell",
        "AXLayoutArea",
        "AXLayoutItem",
    ] {
        let (kind, insertable, reason) = classify_target(role, None, settable, none);
        assert_eq!(
            (kind, insertable, reason),
            ("unsupported", false, Some(GRID_REASON))
        );
    }
    let in_grid = || vec!["AXRow".to_string(), "AXTable".into(), "AXWindow".into()];
    assert!(!classify_target("AXGroup", None, settable, in_grid).1);
    assert!(!classify_target("AXUnknown", None, settable, in_grid).1);
    // Cell in edit mode: the editor is a text role, inside the grid or not.
    assert!(!is_grid_selection("AXTextArea", &in_grid()));
    assert_eq!(
        classify_target("AXTextArea", None, settable, no_walk),
        ("insertable", true, None)
    );
}

fn facts() -> PasteFacts {
    PasteFacts {
        enabled: true,
        apple_terminal: Some(false),
        field_unchanged: true,
        ..Default::default()
    }
}

#[test]
fn paste_needs_the_setting_an_insertable_target_and_a_non_terminal_app() {
    let ok = target("insertable", Some(42), Some("42:AXTextArea:#1"));
    assert_eq!(may_paste(&ok, &facts(), "hi"), Ok(42));
    let off = PasteFacts {
        enabled: false,
        ..facts()
    };
    assert!(may_paste(&ok, &off, "hi").is_err());
    for apple_terminal in [Some(true), None] {
        let f = PasteFacts {
            apple_terminal,
            ..facts()
        };
        assert!(may_paste(&ok, &f, "hi").is_err());
    }
    let known = PasteFacts {
        known_terminal: true,
        ..facts()
    };
    assert!(may_paste(&ok, &known, "hi").is_err());
    for kind in ["secure", "changed", "unavailable", "unsupported"] {
        let snap = target(kind, Some(42), Some("42:AXTextArea:#1"));
        assert!(may_paste(&snap, &facts(), "hi").is_err(), "{kind}");
    }
    let no_pid = target("insertable", None, Some("x"));
    assert!(may_paste(&no_pid, &facts(), "hi").is_err());
}

fn with_writes(writes: &[Result<(), i32>]) -> PasteFacts {
    PasteFacts {
        attempt: AxAttempt {
            writes: writes.to_vec(),
            ..Default::default()
        },
        ..facts()
    }
}

#[test]
fn an_ax_error_that_may_have_applied_never_reaches_paste() {
    let ok = target("insertable", Some(42), Some("42:AXTextArea:#1"));
    // -25204 CannotComplete (a busy Word), -25200 Failure, and anything else
    // not proven write-free, alone or after an Ok first write (the retry).
    for writes in [
        vec![Err(-25204)],
        vec![Err(-25200)],
        vec![Err(-25212)],
        vec![Err(-25203)],
        vec![Ok(()), Err(-25204)],
        vec![Err(-25205), Err(-25200)],
    ] {
        let gate = may_paste(&ok, &with_writes(&writes), "hi");
        assert_eq!(
            gate,
            Err("AX error may have applied the write"),
            "{writes:?}"
        );
        let mut diag = DeliveryDiag::default();
        let got = after_ax_refusal(
            Err("AX set AXSelectedText failed (error -25204)".into()),
            gate,
            |_| panic!("no paste after {writes:?}"),
            || panic!("no read-back"),
            &mut diag,
        );
        assert!(got.is_err());
        assert!(diag.fallback.starts_with("skipped("), "{}", diag.fallback);
    }
    // Write-free errors, a refusal before any write, and Ok writes proven
    // unchanged (Chromium retry: two writes) may paste.
    for code in WRITE_FREE_AX_ERRORS {
        assert_eq!(may_paste(&ok, &with_writes(&[Err(*code)]), "hi"), Ok(42));
    }
    assert_eq!(may_paste(&ok, &with_writes(&[]), "hi"), Ok(42));
    assert_eq!(
        may_paste(&ok, &with_writes(&[Ok(()), Ok(())]), "hi"),
        Ok(42)
    );
    assert_eq!(
        may_paste(&ok, &with_writes(&[Ok(()), Err(-25205)]), "hi"),
        Ok(42)
    );
}

#[test]
fn multi_line_text_in_a_chromium_or_electron_web_field_stays_copy() {
    let ok = target("insertable", Some(42), Some("42:AXTextArea:#1"));
    let multi = "echo one\necho two";
    let web = |web_host, web_content| PasteFacts {
        web_host,
        web_content,
        ..facts()
    };
    // VS Code / Cursor xterm.js, Slack, Brave: Electron/Chromium web fields
    // keep the typing route; the paste fallback never runs, whatever the text.
    for text in [multi, "one line"] {
        assert_eq!(
            may_paste(&ok, &web(true, true), text),
            Err("Chromium/Electron web field")
        );
    }
    // The typing route refused (multi-line) or ran: Copy, no paste.
    let typed = PasteFacts {
        attempt: AxAttempt {
            typed: true,
            ..Default::default()
        },
        web_host: true,
        ..facts()
    };
    assert!(may_paste(&ok, &typed, "one line").is_err());
    // Other web hosts and web content (a partial Chromium tree, WebKit Mail,
    // Tauri): single-line only.
    for (host, content) in [(true, false), (false, true)] {
        assert_eq!(
            may_paste(&ok, &web(host, content), multi),
            Err("multi-line or control text in web content")
        );
        assert!(may_paste(&ok, &web(host, content), "a\tb").is_err());
        assert_eq!(may_paste(&ok, &web(host, content), "one line"), Ok(42));
    }
    // Native fields (Word, Pages) keep multi-line.
    assert_eq!(may_paste(&ok, &facts(), multi), Ok(42));
    // The end to end decision: Copy, and the ⌘V closure never runs.
    let mut diag = DeliveryDiag::default();
    let got = after_ax_refusal(
        Err("Transcript contains control or line separator — nothing sent".into()),
        may_paste(&ok, &web(true, true), multi),
        |_| panic!("no paste into an Electron web field"),
        || panic!("no read-back"),
        &mut diag,
    );
    assert!(got.is_err());
    assert_eq!(diag.fallback, "skipped(Chromium/Electron web field)");
}

#[test]
fn web_content_is_any_role_in_or_under_a_web_area() {
    let none: [&str; 0] = [];
    assert!(in_web_content("AXWebArea", false, &none));
    assert!(in_web_content("AXGroup", true, &none));
    assert!(in_web_content("AXGroup", false, &["AXGroup", "AXWebArea"]));
    assert!(!in_web_content(
        "AXTextArea",
        false,
        &["AXScrollArea", "AXWindow"]
    ));
}

#[test]
fn a_field_that_changed_before_the_paste_aborts_it() {
    let ok = target("insertable", Some(42), Some("42:AXTextArea:#1"));
    let before = ValueStatus::Text("ab".into());
    for now in [
        ValueStatus::Text("abX".into()),
        ValueStatus::Text("".into()),
        ValueStatus::Unreadable(Some(-25204)),
    ] {
        let changed = PasteFacts {
            field_unchanged: field_unchanged(&before, &now),
            ..facts()
        };
        assert_eq!(
            may_paste(&ok, &changed, "hi"),
            Err("field changed since the AX attempt"),
            "{now:?}"
        );
    }
    assert!(field_unchanged(&before, &ValueStatus::Text("ab".into())));
    assert!(field_unchanged(
        &ValueStatus::NoValue,
        &ValueStatus::Text("".into())
    ));
    let unreadable = ValueStatus::Unreadable(None);
    assert!(field_unchanged(&unreadable, &unreadable));
    assert!(!field_unchanged(&unreadable, &before));
}

#[test]
fn only_a_write_free_refusal_pastes_never_a_partial_write() {
    let mut diag = DeliveryDiag::default();
    let writes = || {
        [
            InsertReport::default(),
            InsertReport {
                unverified: true,
                detail: Some("AX write changed the field but could not be verified".into()),
                ..Default::default()
            },
            InsertReport {
                typed: true,
                unverified: true,
                ..Default::default()
            },
        ]
    };
    for (ax, expected) in writes().into_iter().zip(writes()) {
        let got = after_ax_refusal(
            Ok(ax),
            Ok(42),
            |_| panic!("no paste after a write"),
            || panic!("no read-back"),
            &mut diag,
        );
        assert_eq!(got, Ok(expected));
    }
    // The AX decision behind those: a changed or unreadable read-back is
    // Unverified (Ok), never Failed (Err), so it can never reach the paste.
    assert_eq!(
        after_ax(false, Ok(()), "a", Some("aX"), "XY"),
        AfterAx::Unverified
    );
    assert_eq!(
        after_ax(false, Err("e".into()), "a", None, "XY"),
        AfterAx::Unverified
    );
}

#[test]
fn a_refusal_pastes_once_and_reports_verified_or_maybe() {
    for (verified, unverified) in [(true, false), (false, true)] {
        let mut diag = DeliveryDiag::default();
        let mut pasted = Vec::new();
        let report = after_ax_refusal(
            Err("AXValue unreadable before insert — insert skipped".into()),
            Ok(42),
            |pid| {
                pasted.push(pid);
                Ok(restored())
            },
            || verified,
            &mut diag,
        )
        .unwrap();
        assert_eq!(pasted, [42]);
        assert_eq!(report.unverified, unverified);
        assert_eq!(report.paste, Some(restored()));
        assert!(!report.typed);
    }
}

#[test]
fn a_refused_or_ungated_paste_stays_copy() {
    let mut diag = DeliveryDiag::default();
    let err = after_ax_refusal(
        Err("refused".into()),
        Err("clipboard fallback off"),
        |_| panic!("gated"),
        || panic!("no read-back"),
        &mut diag,
    )
    .unwrap_err();
    assert_eq!(err, "refused");
    assert_eq!(diag.fallback, "skipped(clipboard fallback off)");
    let err = after_ax_refusal(
        Err("refused".into()),
        Ok(42),
        |_| Err("Secure Keyboard Entry is on — paste skipped".into()),
        || panic!("no read-back"),
        &mut diag,
    )
    .unwrap_err();
    assert!(err.starts_with("refused; ⌘V fallback skipped: Secure Keyboard Entry"));
}

#[test]
fn the_delivery_log_line_never_holds_text_or_field_contents() {
    let before = ValueStatus::Text(SECRET_FIELD.into());
    let mut diag = DeliveryDiag {
        bundle_id: Some("com.microsoft.Word".into()),
        role: Some("AXTextArea".into()),
        value: before.label(),
        settable: EditFacts::default().label(),
        gate: "ax",
        ..Default::default()
    };
    let after = poll_readback(&before, || ValueStatus::Text(SECRET_FIELD.into()), |_| {});
    let outcome = after_ax(false, Ok(()), SECRET_FIELD, after.as_deref(), SECRET_TEXT);
    diag.readback = super::super::diag::readback_label(&outcome);
    let AfterAx::Failed(reason) = outcome else {
        panic!("unchanged field must fail");
    };
    let _ = after_ax_refusal(Err(reason), Ok(7), |_| Ok(restored()), || false, &mut diag);
    let line = diag.line();
    for secret in [SECRET_TEXT, SECRET_FIELD, "secret", "confidential"] {
        assert!(!line.contains(secret), "{line}");
    }
    for field in [
        "bundle=com.microsoft.Word",
        "role=AXTextArea",
        "value=text",
        "gate=ax",
        "readback=unchanged",
        "fallback=paste-unverified",
        "total_ms=",
    ] {
        assert!(line.contains(field), "{field}: {line}");
    }
}
