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
fn identity_distinguishes_sibling_fields() {
    let base = IdentityParts {
        pid: Some(7),
        role: "AXTextField",
        ..Default::default()
    };
    let a = element_identity(&IdentityParts {
        position: Some((10, 20)),
        ..base
    });
    let b = element_identity(&IdentityParts {
        pid: Some(7),
        role: "AXTextField",
        position: Some((10, 60)),
        ..Default::default()
    });
    let c = element_identity(&IdentityParts {
        pid: Some(7),
        role: "AXTextField",
        dom_identifier: Some("email"),
        position: Some((10, 20)),
        ..Default::default()
    });
    assert_ne!(a, b);
    assert_ne!(a, c);
    let a2 = element_identity(&IdentityParts {
        pid: Some(7),
        role: "AXTextField",
        position: Some((10, 20)),
        ..Default::default()
    });
    assert_eq!(a, a2);
}
