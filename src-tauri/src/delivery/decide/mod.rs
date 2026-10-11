//! Platform-independent delivery decisions (pure; unit-tested on any OS).
//! The macOS adapter gathers AX facts and delegates every policy choice here.

pub mod host;
pub mod length;
pub mod report;
pub mod retry;
pub mod target;
pub mod terminal;
pub mod text;
pub mod verify;
pub mod web;
pub mod web_ax;

pub use host::unicode_typing_supported;
pub use report::InsertReport;
pub use target::{classify_role, effective_role, element_token, validate_snapshots};
pub use text::{check_insert_text, utf16_chunks, KEY_EVENT_UTF16_MAX};
pub use verify::{after_ax, value_confirms_insert, AfterAx};
pub use web::{choose_insert_path, is_web_content_field, InsertPath};

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
