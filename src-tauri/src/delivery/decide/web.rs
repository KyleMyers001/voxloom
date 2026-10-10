//! Web-content detection and insert path choice.

use super::target::classify_role;
use crate::delivery::types::TargetSnapshotDto;

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

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;
