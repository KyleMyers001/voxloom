//! Target classification, field identity and snapshot validation.

use crate::delivery::types::TargetSnapshotDto;

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

#[cfg(test)]
#[path = "target_tests.rs"]
mod tests;
