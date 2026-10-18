use super::*;
use crate::delivery::decide::test_support::target;
use crate::delivery::decide::web::is_web_content_field;

#[test]
fn unavailable_focus_is_not_evidence_of_app_closure() {
    let checked = validate_snapshots(
        &target("insertable", Some(42), Some("42:AXTextArea:")),
        target("unavailable", None, None),
    );
    assert_eq!(checked.kind, "unavailable");
}

#[test]
fn changed_or_unidentifiable_target_is_not_insertable() {
    let intended = target("insertable", Some(42), Some("42:AXTextArea:"));
    for (current, expected) in [
        (
            target("insertable", Some(43), Some("43:AXTextArea:")),
            "changed",
        ),
        (
            target("insertable", Some(42), Some("42:AXTextArea:other")),
            "changed",
        ),
        (
            target("insertable", None, Some("-1:AXTextArea:")),
            "unavailable",
        ),
        (target("insertable", Some(42), None), "unavailable"),
    ] {
        let checked = validate_snapshots(&intended, current);
        assert!(!checked.insertable);
        assert_eq!(checked.kind, expected);
    }
    assert!(validate_snapshots(&intended, intended.clone()).insertable);
}

#[test]
fn missing_invocation_identity_never_accepts_current_focus() {
    let current = target("insertable", Some(42), Some("42:AXTextArea:"));
    // Capture-start snapshot failed: no pid / element id.
    let checked = validate_snapshots(&target("unavailable", None, None), current.clone());
    assert!(!checked.insertable);
    let mut no_id = target("insertable", Some(42), None);
    no_id.insertable = true;
    assert!(!validate_snapshots(&no_id, current).insertable);
}

#[test]
fn secure_subrole_is_refused_even_with_text_field_role() {
    let role = effective_role("AXTextField", Some("AXSecureTextField"));
    let (kind, insertable, _) = classify_role(role);
    assert_eq!(kind, "secure");
    assert!(!insertable);
    assert_eq!(
        effective_role("AXTextField", Some("AXSearchField")),
        "AXTextField"
    );
    assert_eq!(effective_role("AXTextField", None), "AXTextField");
    assert!(!is_web_content_field(role, true, &["AXWebArea"]));
}

#[test]
fn token_distinguishes_registered_element_from_any_other() {
    let intended = element_token(Some(7), "AXTextField", Some(3));
    assert_eq!(intended, element_token(Some(7), "AXTextField", Some(3)));
    // Sibling with identical attributes is not the registered element.
    assert_ne!(intended, element_token(Some(7), "AXTextField", None));
    // A newer capture's element never matches an older intended snapshot.
    assert_ne!(intended, element_token(Some(7), "AXTextField", Some(4)));
    // Two unmatched elements are never accepted as the intended one.
    let mut want = crate::delivery::decide::test_support::target("insertable", Some(7), None);
    want.element_id = Some(element_token(Some(7), "AXTextField", Some(3)));
    let mut have = want.clone();
    have.element_id = Some(element_token(Some(7), "AXTextField", None));
    assert_eq!(validate_snapshots(&want, have).kind, "changed");
}
