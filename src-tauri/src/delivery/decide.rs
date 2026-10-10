//! Platform-independent delivery decisions (pure; unit-tested on any OS).
//! The macOS adapter gathers AX facts and delegates every policy choice here.

use serde::Serialize;

use super::types::TargetSnapshotDto;

/// Classify an AX role (after secure-subrole folding) into kind/insertable/reason.
pub fn classify_role(role: &str) -> (&'static str, bool, Option<&'static str>) {
    match role {
        "AXSecureTextField" => ("secure", false, Some("secure field — insert skipped")),
        "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField" => ("insertable", true, None),
        // Containers do not establish an editable caret. AXSelectedText may
        // return success here without changing the actual editor.
        "AXWebArea" | "AXScrollArea" | "AXGroup" => (
            "unsupported",
            false,
            Some("generic web/container role — insert unverified"),
        ),
        // Terminals often expose AXTextArea already; unknown custom roles refuse.
        "AXStaticText" | "AXButton" | "AXImage" | "AXToolbar" | "AXMenu" => {
            ("unsupported", false, Some("unsupported control role"))
        }
        _ => ("unsupported", false, Some("unsupported or unknown AX role")),
    }
}

/// Password fields keep role AXTextField; the AXSecureTextField subrole marks
/// them secure. Fold that into the role used for classification.
pub fn effective_role<'a>(role: &'a str, subrole: Option<&str>) -> &'a str {
    if role == "AXSecureTextField" || subrole == Some("AXSecureTextField") {
        "AXSecureTextField"
    } else {
        role
    }
}

/// AX facts that identify one focused field.
#[derive(Default)]
pub struct IdentityParts<'a> {
    pub pid: Option<i32>,
    pub role: &'a str,
    pub identifier: Option<&'a str>,
    pub dom_identifier: Option<&'a str>,
    pub title: Option<&'a str>,
    pub description: Option<&'a str>,
    pub position: Option<(i64, i64)>,
}

/// Identity distinguishing sibling fields that share role/description:
/// explicit identifiers plus on-screen position. Position shifts (scroll,
/// window move) make validation refuse, which is the fail-closed direction.
pub fn element_identity(p: &IdentityParts) -> String {
    let pos = p
        .position
        .map(|(x, y)| format!("{x},{y}"))
        .unwrap_or_default();
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        p.pid.unwrap_or(-1),
        p.role,
        p.identifier.unwrap_or_default(),
        p.dom_identifier.unwrap_or_default(),
        p.title.unwrap_or_default(),
        p.description.unwrap_or_default(),
        pos
    )
}

/// An editable field hosted in web content (Chromium/Electron/WebKit): it has
/// a DOM identifier or sits under an AXWebArea. Containers themselves are
/// refused by `classify_role`, never treated as web fields.
pub fn is_web_content_field<S: AsRef<str>>(
    role: &str,
    has_dom_identifier: bool,
    ancestor_roles: &[S],
) -> bool {
    if classify_role(role).0 != "insertable" {
        return false;
    }
    has_dom_identifier || ancestor_roles.iter().any(|r| r.as_ref() == "AXWebArea")
}

/// Compare the invocation snapshot with the element we are about to mutate.
pub fn validate_snapshots(
    intended: &TargetSnapshotDto,
    current: TargetSnapshotDto,
) -> TargetSnapshotDto {
    // Missing AX focus is not evidence that the original application closed.
    if current.kind == "unavailable" || current.kind == "secure" || !current.insertable {
        return current;
    }
    if intended.kind != "insertable" || !intended.insertable {
        return intended.clone();
    }
    let unidentified = |current: TargetSnapshotDto| TargetSnapshotDto {
        insertable: false,
        kind: "unavailable".into(),
        reason: Some("target identity unavailable — insert skipped".into()),
        ..current
    };
    match (intended.app_pid, current.app_pid) {
        (Some(want), Some(have)) if want != have => {
            return TargetSnapshotDto {
                insertable: false,
                kind: "changed".into(),
                reason: Some("target changed (different app)".into()),
                ..current
            };
        }
        (Some(_), Some(_)) => {}
        _ => return unidentified(current),
    }
    match (intended.element_id.as_ref(), current.element_id.as_ref()) {
        (Some(want), Some(have)) if want != have => TargetSnapshotDto {
            insertable: false,
            kind: "changed".into(),
            reason: Some("target changed (different field)".into()),
            ..current
        },
        (Some(_), Some(_)) => current,
        _ => unidentified(current),
    }
}

/// How to deliver into a validated target. `Refuse` → TS Copy/Failed policy.
#[derive(Debug, PartialEq, Eq)]
pub enum InsertPath {
    /// ⌘V into a web-content field, verified by AXValue read-back.
    WebPaste,
    /// Caret-aware AXSelectedText, verified by AXValue read-back.
    AxSelectedText,
    Refuse(String),
}

pub fn choose_insert_path(
    validated: &TargetSnapshotDto,
    is_web_field: bool,
    value_readable: bool,
) -> InsertPath {
    if !validated.insertable || validated.kind != "insertable" {
        return InsertPath::Refuse(format!(
            "refusing insert: {}",
            validated
                .reason
                .clone()
                .unwrap_or_else(|| validated.kind.clone())
        ));
    }
    // Both paths need a readable value to prove the text actually landed;
    // without it we refuse before mutating anything (no double insert).
    if !value_readable {
        return InsertPath::Refuse("AXValue unreadable before insert — insert skipped".into());
    }
    if is_web_field {
        InsertPath::WebPaste
    } else {
        InsertPath::AxSelectedText
    }
}

/// Read-back proof that our text landed in the field.
pub fn value_confirms_insert(before: &str, after: &str, text: &str) -> bool {
    !text.is_empty() && before != after && after.contains(text)
}

/// What the clipboard held before our temporary paste.
#[derive(Debug, PartialEq, Eq)]
pub enum ClipboardPrior {
    /// Only plain-text flavors: safe to restore byte-for-byte via pbcopy.
    PlainText(String),
    /// Image / file / rich (RTF, HTML) or any non-text flavor: pbpaste cannot
    /// capture it, so restoring would overwrite it with a lossy/empty string.
    NonText,
    /// Nothing on the clipboard (no flavors).
    Empty,
    /// Could not inspect the clipboard.
    Unreadable,
}

/// Plain-text pasteboard flavors as reported by AppleScript `clipboard info`.
const PLAIN_TEXT_FLAVORS: &[&str] = &[
    "string",
    "unicode text",
    "text",
    "«class utf8»",
    "«class ut16»",
    "utf8",
    "ut16",
];

/// Classify the prior clipboard from AppleScript `clipboard info` output
/// (e.g. `«class PNGf», 1234, string, 5`) plus the `pbpaste` text.
/// Any non-plain-text flavor → NonText (we cannot restore it faithfully).
pub fn classify_clipboard(info: Option<&str>, text: Option<&str>) -> ClipboardPrior {
    let Some(info) = info else {
        return ClipboardPrior::Unreadable;
    };
    let flavors: Vec<String> = info
        .split(',')
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty() && p.parse::<i64>().is_err())
        .collect();
    if flavors.is_empty() {
        return ClipboardPrior::Empty;
    }
    if flavors
        .iter()
        .any(|f| !PLAIN_TEXT_FLAVORS.contains(&f.as_str()))
    {
        return ClipboardPrior::NonText;
    }
    match text {
        // Text flavors present but pbpaste returned nothing: do not trust it.
        Some(t) if !t.is_empty() => ClipboardPrior::PlainText(t.to_string()),
        Some(_) => ClipboardPrior::NonText,
        None => ClipboardPrior::Unreadable,
    }
}

/// Clipboard restore decision after a temporary paste.
#[derive(Debug, PartialEq, Eq)]
pub enum RestoreDecision {
    Restore(String),
    Skip(&'static str),
}

pub fn restore_decision(prior: &ClipboardPrior, now: Option<&str>, text: &str) -> RestoreDecision {
    let prev = match prior {
        ClipboardPrior::PlainText(p) => p,
        ClipboardPrior::NonText => {
            return RestoreDecision::Skip(
                "clipboard held non-text data (image, file or rich text) that cannot be restored",
            )
        }
        ClipboardPrior::Empty => return RestoreDecision::Skip("clipboard was empty before paste"),
        ClipboardPrior::Unreadable => {
            return RestoreDecision::Skip("original clipboard could not be read")
        }
    };
    match now {
        Some(now) if now == text => RestoreDecision::Restore(prev.clone()),
        Some(_) => RestoreDecision::Skip("clipboard changed after our write"),
        None => RestoreDecision::Skip("clipboard could not be re-read"),
    }
}

/// Refuse text that would be silently mangled: an empty AXSelectedText write
/// deletes the user's selection, and interior NULs truncate CFStrings.
pub fn check_insert_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("empty transcript — insert skipped".into());
    }
    if text.contains('\0') {
        return Err("transcript contains NUL — insert skipped".into());
    }
    Ok(())
}

/// Error text for a ⌘V whose effect could not be read back. The text may be
/// in the page already; TS shows "May have been pasted — also copied".
pub const UNVERIFIED_PASTE: &str = "⌘V sent but could not be verified — may have been pasted";

/// Native insert result surfaced to TypeScript.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InsertReport {
    /// Delivered by temporary clipboard paste (web content).
    pub pasted: bool,
    /// Prior clipboard restored after the paste.
    pub clipboard_restored: bool,
    /// Why restore was skipped (conflict, unreadable, write failure).
    pub restore_skipped_reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(kind: &str, pid: Option<i32>, id: Option<&str>) -> TargetSnapshotDto {
        TargetSnapshotDto {
            app_name: Some("Notes".into()),
            app_pid: pid,
            captured_at: 1,
            element_id: id.map(str::to_string),
            element_role: Some("AXTextArea".into()),
            insertable: kind == "insertable",
            kind: kind.into(),
            reason: if kind == "unavailable" {
                Some("Accessibility permission denied — insert skipped".into())
            } else {
                None
            },
        }
    }

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

    #[test]
    fn path_choice() {
        let ok = target("insertable", Some(1), Some("1:AXTextField:"));
        assert_eq!(choose_insert_path(&ok, true, true), InsertPath::WebPaste);
        assert_eq!(
            choose_insert_path(&ok, false, true),
            InsertPath::AxSelectedText
        );
        assert!(matches!(
            choose_insert_path(&ok, true, false),
            InsertPath::Refuse(_)
        ));
        assert!(matches!(
            choose_insert_path(&ok, false, false),
            InsertPath::Refuse(_)
        ));
        for kind in ["secure", "changed", "unavailable", "unsupported"] {
            assert!(matches!(
                choose_insert_path(&target(kind, Some(1), Some("x")), true, true),
                InsertPath::Refuse(_)
            ));
        }
    }

    #[test]
    fn insertion_requires_readback_change_containing_transcript() {
        assert!(value_confirms_insert("hello", "hello world", " world"));
        assert!(value_confirms_insert("old line", "new line", "new line"));
        assert!(!value_confirms_insert("hello", "hello", " world"));
        assert!(!value_confirms_insert("hello", "hello!", " world"));
        assert!(!value_confirms_insert("hello", "hello!", ""));
    }

    #[test]
    fn clipboard_restore_only_when_still_ours() {
        let prior = ClipboardPrior::PlainText("prior".into());
        assert_eq!(
            restore_decision(&prior, Some("dictated"), "dictated"),
            RestoreDecision::Restore("prior".into())
        );
        assert_eq!(
            restore_decision(&prior, Some("user copied"), "dictated"),
            RestoreDecision::Skip("clipboard changed after our write")
        );
        assert!(matches!(
            restore_decision(&prior, None, "d"),
            RestoreDecision::Skip(_)
        ));
        for p in [
            ClipboardPrior::NonText,
            ClipboardPrior::Empty,
            ClipboardPrior::Unreadable,
        ] {
            assert!(matches!(
                restore_decision(&p, Some("d"), "d"),
                RestoreDecision::Skip(_)
            ));
        }
    }

    #[test]
    fn clipboard_classification_never_restores_empty_or_non_text() {
        // Image on clipboard: pbpaste returns "" — must not become Restore("").
        assert_eq!(
            classify_clipboard(Some("«class PNGf», 5120, «class TIFF», 9000"), Some("")),
            ClipboardPrior::NonText
        );
        // Rich text copy from a browser: has HTML/RTF alongside string.
        assert_eq!(
            classify_clipboard(
                Some("«class HTML», 40, «class utf8», 5, string, 5"),
                Some("hello")
            ),
            ClipboardPrior::NonText
        );
        // File copy from Finder.
        assert_eq!(
            classify_clipboard(Some("«class furl», 30, string, 9"), Some("a.txt")),
            ClipboardPrior::NonText
        );
        assert_eq!(
            classify_clipboard(
                Some("«class utf8», 6, «class ut16», 14, string, 6"),
                Some("héllo")
            ),
            ClipboardPrior::PlainText("héllo".into())
        );
        assert_eq!(
            classify_clipboard(Some("string, 0"), Some("")),
            ClipboardPrior::NonText
        );
        assert_eq!(
            classify_clipboard(Some(""), Some("")),
            ClipboardPrior::Empty
        );
        assert_eq!(
            classify_clipboard(None, Some("x")),
            ClipboardPrior::Unreadable
        );
        assert_eq!(
            restore_decision(
                &classify_clipboard(Some("«class PNGf», 1"), Some("")),
                Some("d"),
                "d"
            ),
            RestoreDecision::Skip(
                "clipboard held non-text data (image, file or rich text) that cannot be restored"
            )
        );
    }

    #[test]
    fn refuses_empty_or_nul_text() {
        assert!(check_insert_text("").is_err());
        assert!(check_insert_text("a\0b").is_err());
        assert!(check_insert_text("héllo 👋 你好").is_ok());
    }

    #[test]
    fn insert_report_serializes_camel_case() {
        let r = InsertReport {
            pasted: true,
            clipboard_restored: false,
            restore_skipped_reason: Some("x".into()),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["restoreSkippedReason"], "x");
        assert_eq!(v["clipboardRestored"], false);
    }
}
