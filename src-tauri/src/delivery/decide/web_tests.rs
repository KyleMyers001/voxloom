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
    assert_eq!(choose_insert_path(&ok, true), InsertPath::AxSelectedText);
    assert_eq!(
        choose_insert_path(&ok, false),
        InsertPath::AxSelectedTextUnreadable
    );
    for kind in ["secure", "changed", "unavailable", "unsupported"] {
        assert!(matches!(
            choose_insert_path(&target(kind, Some(1), Some("x")), true),
            InsertPath::Refuse(_)
        ));
    }
}

#[test]
fn unreadable_value_never_unlocks_secure_fields() {
    let mut secure = target("insertable", Some(1), Some("x"));
    secure.element_role = Some("AXSecureTextField".into());
    assert!(matches!(
        choose_insert_path(&secure, false),
        InsertPath::Refuse(_)
    ));
    for kind in ["secure", "changed", "unavailable", "unsupported"] {
        assert!(matches!(
            choose_insert_path(&target(kind, Some(1), Some("x")), false),
            InsertPath::Refuse(_)
        ));
    }
}

#[test]
fn messages_like_text_area_with_unreadable_value_is_attempted() {
    // Role AXTextArea, insertable, AXValue not a readable string.
    let messages = target("insertable", Some(9), Some("9:AXTextArea:#1"));
    assert_eq!(
        choose_insert_path(&messages, false),
        InsertPath::AxSelectedTextUnreadable
    );
}
