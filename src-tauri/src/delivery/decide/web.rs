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
    /// Editable, non-secure text element whose AXValue cannot be read (e.g.
    /// Messages): write AXSelectedText once, verify by character count or
    /// report Unverified. Never used for secure fields.
    AxSelectedTextUnreadable,
    TerminalUnicode,
    Refuse(String),
}

/// `unreadable_ok`: the host is allowlisted for the unreadable-AXValue path
/// (`decide::messages::unreadable_value_allowed`, Messages only).
pub fn choose_insert_path(
    validated: &TargetSnapshotDto,
    value_readable: bool,
    unreadable_ok: bool,
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
    // Without a readable value we cannot prove the exact text landed. Only
    // Messages (allowlisted) may proceed: verified by character count, or
    // Unverified (amends BUS-14; docs/decisions/unreadable-axvalue.md). The
    // secure-field guard is absolute and checked first, independently.
    if !value_readable {
        let role = validated.element_role.as_deref().unwrap_or_default();
        if validated.kind == "secure" || role == "AXSecureTextField" {
            return InsertPath::Refuse("secure field — insert skipped".into());
        }
        if !unreadable_ok {
            return InsertPath::Refuse("AXValue unreadable before insert — insert skipped".into());
        }
        return InsertPath::AxSelectedTextUnreadable;
    }
    InsertPath::AxSelectedText
}

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;
