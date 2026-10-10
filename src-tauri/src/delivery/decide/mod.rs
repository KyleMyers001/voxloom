//! Platform-independent delivery decisions (pure; unit-tested on any OS).
//! The macOS adapter gathers AX facts and delegates every policy choice here.

pub mod clipboard;
pub mod target;
pub mod text;
pub mod web;

pub use clipboard::{
    classify_clipboard, restore_decision, ClipboardPrior, InsertReport, RestoreDecision,
};
pub use target::{
    classify_role, effective_role, element_identity, validate_snapshots, IdentityParts,
};
pub use text::{check_insert_text, UNVERIFIED_PASTE};
pub use web::{choose_insert_path, is_web_content_field, value_confirms_insert, InsertPath};

#[cfg(test)]
pub(crate) mod test_support {
    use crate::delivery::types::TargetSnapshotDto;

    pub fn target(kind: &str, pid: Option<i32>, id: Option<&str>) -> TargetSnapshotDto {
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
}
