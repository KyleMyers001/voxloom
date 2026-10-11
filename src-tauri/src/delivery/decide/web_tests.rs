use super::*;
use crate::delivery::decide::target::classify_role;
use crate::delivery::decide::test_support::target;

#[test]
fn generic_web_containers_never_claim_insertability() {
    for role in ["AXWebArea", "AXScrollArea", "AXGroup"] {
        let (kind, insertable, _) = classify_role(role);
        assert_eq!(kind, "unsupported");
        assert!(!insertable);
        // Even with a DOM id / web ancestor, containers are not web fields.
        assert!(!is_web_content_field(role, true, &["AXWebArea"]));
    }
    assert!(classify_role("AXTextArea").1);
}

#[test]
fn web_content_detection() {
    let none: [&str; 0] = [];
    assert!(is_web_content_field("AXTextField", true, &none));
    assert!(is_web_content_field(
        "AXTextArea",
        false,
        &["AXGroup", "AXWebArea", "AXWindow"]
    ));
    // Address bar / Notes: native field, no web ancestor.
    assert!(!is_web_content_field(
        "AXTextField",
        false,
        &["AXToolbar", "AXWindow"]
    ));
    assert!(!is_web_content_field("AXTextArea", false, &none));
}

#[test]
fn path_choice() {
    let ok = target("insertable", Some(1), Some("1:AXTextField:#1"));
    assert_eq!(
        choose_insert_path(&ok, true, false),
        InsertPath::AxSelectedText
    );
    assert_eq!(
        choose_insert_path(&ok, false, true),
        InsertPath::MessagesGuarded
    );
    for kind in ["secure", "changed", "unavailable", "unsupported"] {
        assert!(matches!(
            choose_insert_path(&target(kind, Some(1), Some("x")), true, true),
            InsertPath::Refuse(_)
        ));
    }
}

#[test]
fn unreadable_value_never_unlocks_secure_fields() {
    let mut secure = target("insertable", Some(1), Some("x"));
    secure.element_role = Some("AXSecureTextField".into());
    assert!(matches!(
        choose_insert_path(&secure, false, true),
        InsertPath::Refuse(_)
    ));
    for kind in ["secure", "changed", "unavailable", "unsupported"] {
        assert!(matches!(
            choose_insert_path(&target(kind, Some(1), Some("x")), false, true),
            InsertPath::Refuse(_)
        ));
    }
}

#[test]
fn messages_takes_the_guarded_flow_whether_or_not_value_is_readable() {
    // Attempt 1: empty composer, AXValue unreadable. Attempt 2 (Kyle's Air):
    // composer has text, AXValue readable — previously fell through to the
    // plain AXSelectedText path and failed "reported success but nothing
    // changed" with no typing fallback.
    let messages = target("insertable", Some(9), Some("9:AXTextArea:#1"));
    for readable in [false, true] {
        assert_eq!(
            choose_insert_path(&messages, readable, true),
            InsertPath::MessagesGuarded
        );
    }
    let mut secure = messages.clone();
    secure.element_role = Some("AXSecureTextField".into());
    for readable in [false, true] {
        assert!(matches!(
            choose_insert_path(&secure, readable, true),
            InsertPath::Refuse(_)
        ));
    }
}

#[test]
fn unreadable_value_refused_outside_the_messages_allowlist() {
    let other = target("insertable", Some(9), Some("9:AXTextArea:#1"));
    assert_eq!(
        choose_insert_path(&other, false, false),
        InsertPath::Refuse("AXValue unreadable before insert — insert skipped".into())
    );
    // Readable values are unaffected by the allowlist.
    assert_eq!(
        choose_insert_path(&other, true, false),
        InsertPath::AxSelectedText
    );
}
