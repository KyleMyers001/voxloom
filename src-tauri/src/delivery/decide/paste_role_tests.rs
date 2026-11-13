use super::*;
use crate::delivery::decide::fallback::under_grid;
use crate::delivery::decide::test_support::target;
use crate::delivery::decide::{choose_insert_path, InsertPath};

fn no_walk() -> Vec<String> {
    panic!("ancestors must not be walked")
}

fn no_facts() -> EditFacts {
    panic!("edit facts must not be read")
}

/// Every edit attribute settable and a text value: the strongest evidence.
fn all() -> EditFacts {
    EditFacts {
        value: true,
        selected_text: true,
        selected_range: true,
        text_value: true,
    }
}

#[test]
fn allowlisted_and_secure_roles_classify_as_before() {
    for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"] {
        assert_eq!(
            classify_target(role, None, no_facts, no_walk),
            classify_role(role)
        );
    }
    let secure = classify_target("AXTextField", Some("AXSecureTextField"), all, no_walk);
    assert_eq!(secure.0, "secure");
    assert!(!classify_target("unknown", None, all, no_walk).1);
}

#[test]
fn controls_never_become_paste_targets_even_with_caret_evidence() {
    // Date pickers, steppers, sliders, Finder items, links, menus, ...
    for role in [
        "AXScrollBar",
        "AXIncrementor",
        "AXDisclosureTriangle",
        "AXSplitter",
        "AXColorWell",
        "AXDateField",
        "AXTimeField",
        "AXValueIndicator",
        "AXLevelIndicator",
        "AXRadioGroup",
        "AXTabGroup",
        "AXMenuButton",
        "AXLink",
        "AXSlider",
        "AXPopUpButton",
        "AXCheckBox",
        "AXButton",
        "AXList",
        "AXTable",
        "AXOutline",
        "AXRow",
        "AXCell",
        "AXStaticText",
        "AXImage",
        "AXMenu",
        "AXMenuItem",
        "AXRadioButton",
        "AXWindow",
    ] {
        let (kind, insertable, _) = classify_target(role, None, all, no_walk);
        assert_eq!((kind, insertable), ("unsupported", false), "{role}");
    }
}

#[test]
fn a_settable_value_alone_is_not_caret_evidence() {
    let value_only = || EditFacts {
        value: true,
        text_value: true,
        ..Default::default()
    };
    for role in [
        "AXWebArea",
        "AXGroup",
        "AXScrollArea",
        "AXDocument",
        "AXUnknown",
    ] {
        assert!(
            !classify_target(role, None, value_only, no_walk).1,
            "{role}"
        );
        assert!(
            !classify_target(role, None, EditFacts::default, no_walk).1,
            "{role}"
        );
    }
}

#[test]
fn containers_with_a_caret_become_paste_only_targets() {
    let none: fn() -> Vec<String> = Vec::new;
    for caret in [
        EditFacts {
            selected_range: true,
            ..Default::default()
        },
        EditFacts {
            selected_text: true,
            ..Default::default()
        },
    ] {
        // No text value needed for the four known containers.
        for role in ["AXWebArea", "AXGroup", "AXScrollArea", "AXDocument"] {
            assert_eq!(
                classify_target(role, None, || caret, none),
                ("insertable", true, None),
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
}

#[test]
fn unknown_custom_roles_need_a_caret_and_a_text_value() {
    let none: fn() -> Vec<String> = Vec::new;
    let caret_only = || EditFacts {
        selected_range: true,
        value: true,
        ..Default::default()
    };
    for role in ["AXUnknown", "MSOfficeTextCanvas"] {
        assert!(!classify_target(role, None, caret_only, none).1, "{role}");
        assert_eq!(
            classify_target(role, None, all, none),
            ("insertable", true, None),
            "{role}"
        );
    }
}

#[test]
fn a_grid_selection_is_never_a_target_but_a_cell_editor_keeps_the_ax_write() {
    let none: fn() -> Vec<String> = Vec::new;
    for role in [
        "AXTable",
        "AXGrid",
        "AXCell",
        "AXLayoutArea",
        "AXLayoutItem",
    ] {
        let (kind, insertable, reason) = classify_target(role, None, all, none);
        assert_eq!(
            (kind, insertable, reason),
            ("unsupported", false, Some(GRID_REASON))
        );
    }
    let in_grid = || vec!["AXRow".to_string(), "AXTable".into(), "AXWindow".into()];
    assert!(!classify_target("AXGroup", None, all, in_grid).1);
    assert!(!classify_target("AXUnknown", None, all, in_grid).1);
    // Cell in edit mode: the editor is a text role and keeps the verified AX
    // write; its ⌘V fallback is refused by `under_grid` in `may_paste`.
    assert!(!is_grid_selection("AXTextArea", &in_grid()));
    assert!(under_grid(&in_grid()));
    assert_eq!(
        classify_target("AXTextArea", None, no_facts, no_walk),
        ("insertable", true, None)
    );
}

#[test]
fn edit_facts_label_lists_flags_only() {
    assert_eq!(all().label(), "value=1 selected_text=1 range=1 text=1");
    assert_eq!(
        EditFacts::default().label(),
        "value=0 selected_text=0 range=0 text=0"
    );
}
