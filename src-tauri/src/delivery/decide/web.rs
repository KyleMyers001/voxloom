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

/// Whether to attempt insertion at all. `Refuse` → TS Copy/Failed policy.
/// Every insertable target tries caret-aware AXSelectedText first (main #22);
/// web fields may then fall back to Unicode typing (see `verify::after_ax`).
#[derive(Debug, PartialEq, Eq)]
pub enum InsertPath {
    AxSelectedText,
    Refuse(String),
}

pub fn choose_insert_path(validated: &TargetSnapshotDto, value_readable: bool) -> InsertPath {
    if !validated.insertable || validated.kind != "insertable" {
        return InsertPath::Refuse(format!(
            "refusing insert: {}",
            validated
                .reason
                .clone()
                .unwrap_or_else(|| validated.kind.clone())
        ));
    }
    // A readable value is needed to prove the text actually landed; without
    // it we refuse before mutating anything (no double insert).
    if !value_readable {
        return InsertPath::Refuse("AXValue unreadable before insert — insert skipped".into());
    }
    InsertPath::AxSelectedText
}

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;
