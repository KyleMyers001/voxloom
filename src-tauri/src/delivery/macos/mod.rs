//! macOS Accessibility (AX) target snapshot + text insert.
//! Every insertable target tries caret-aware AXSelectedText first, verified by
//! exact AXValue read-back (main #22). Only a web-content field that left its
//! value unchanged falls back to Unicode key events (no clipboard, no ⌘V).
//! Secure fields, identity mismatches and unverifiable writes never retry;
//! they go to the TS Copy/Failed policy.

mod ax;
mod focus;
mod host;
mod registry;
mod typing;

use std::sync::Mutex;

use ax::{ancestor_roles, copy_string_attr, release, set_ax_string, AXIsProcessTrusted, CFTypeRef};
use focus::{build_snapshot, focused_ui_element, snapshot_at};

use super::decide::{
    after_ax, check_insert_text, choose_insert_path, is_web_content_field, validate_snapshots,
    value_confirms_insert, AfterAx, InsertPath, InsertReport,
};
use super::types::TargetSnapshotDto;

/// Serializes inserts (commands run off the main thread and may overlap).
static INSERT_LOCK: Mutex<()> = Mutex::new(());

pub fn snapshot_target() -> Result<TargetSnapshotDto, String> {
    Ok(snapshot_at("capture start", true))
}

pub fn validate_target(intended: TargetSnapshotDto) -> Result<TargetSnapshotDto, String> {
    Ok(validate_snapshots(
        &intended,
        snapshot_at("delivery validation", false),
    ))
}

fn insert_selected_text_with(
    text: &str,
    set: impl FnOnce(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    // AXValue replaces the entire field; a failed selected-text set must not
    // try another AX mutation. The caller will use the Copy/Failed policy.
    set("AXSelectedText", text)
}

/// Re-read focus and require it to still be the validated, insertable field.
fn focus_still_matches(intended: &TargetSnapshotDto) -> Result<(), String> {
    let (element, app_name) =
        focused_ui_element("typing").map_err(|e| format!("typing aborted — {e}"))?;
    let checked = validate_snapshots(intended, build_snapshot(element, app_name, false));
    release(element as CFTypeRef);
    if checked.insertable && checked.kind == "insertable" {
        return Ok(());
    }
    Err(format!(
        "typing aborted — {}",
        checked.reason.unwrap_or(checked.kind)
    ))
}

/// Poll read-back briefly: typed key events are processed asynchronously.
fn wait_for_insert(element: ax::AXUIElementRef, before: &str, text: &str) -> bool {
    for _ in 0..30 {
        if let Some(after) = copy_string_attr(element, "AXValue") {
            if value_confirms_insert(before, &after, text) {
                return true;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}

fn unverified(typed: bool, detail: String) -> Result<InsertReport, String> {
    Ok(InsertReport {
        typed,
        unverified: true,
        detail: Some(detail),
    })
}

pub fn insert_text(text: &str, intended: &TargetSnapshotDto) -> Result<InsertReport, String> {
    check_insert_text(text)?;
    if !intended.insertable || intended.kind != "insertable" {
        return Err(format!(
            "refusing insert into non-insertable target ({})",
            intended.kind
        ));
    }
    if unsafe { AXIsProcessTrusted() } == 0 {
        return Err("Accessibility permission denied at insert — insert skipped".into());
    }
    let _serial = INSERT_LOCK
        .lock()
        .map_err(|_| "insert lock poisoned".to_string())?;
    // Validate the same element handle we will mutate, not a prior focus read.
    let (element, app_name) =
        focused_ui_element("insert").map_err(|e| format!("insert aborted — {e}"))?;
    let validated = validate_snapshots(intended, build_snapshot(element, app_name, false));
    let before = copy_string_attr(element, "AXValue");
    let result = match choose_insert_path(&validated, before.is_some()) {
        InsertPath::Refuse(reason) => Err(reason),
        InsertPath::AxSelectedText => {
            let before = before.unwrap_or_default();
            let ax = insert_selected_text_with(text, |a, t| set_ax_string(element, a, t));
            let after = copy_string_attr(element, "AXValue");
            let role = validated.element_role.clone().unwrap_or_default();
            let has_dom_id = copy_string_attr(element, "AXDOMIdentifier").is_some();
            // Skip the parent walk when the DOM id already proves web content.
            let ancestors = if has_dom_id {
                Vec::new()
            } else {
                ancestor_roles(element)
            };
            // Type only into web fields of hosts known to honor Unicode events.
            let may_type = is_web_content_field(&role, has_dom_id, &ancestors)
                && validated.app_pid.is_some_and(host::unicode_typing_ok);
            match after_ax(may_type, ax, &before, after.as_deref(), text) {
                AfterAx::Inserted => Ok(InsertReport::default()),
                AfterAx::Failed(err) => Err(err),
                AfterAx::Unverified => unverified(
                    false,
                    "AX write changed the field but could not be verified".into(),
                ),
                AfterAx::TypeFallback => {
                    let (posted, typed) = typing::type_text(
                        text,
                        || focus_still_matches(&validated),
                        |so_far| wait_for_insert(element, &before, so_far),
                    );
                    match typed {
                        Err(err) if posted == 0 => Err(err),
                        Err(err) => unverified(true, format!("{err} (partially typed)")),
                        Ok(()) => Ok(InsertReport {
                            typed: true,
                            ..Default::default()
                        }),
                    }
                }
            }
        }
    };
    release(element as CFTypeRef);
    result
}

#[cfg(test)]
mod tests {
    use super::focus::focus_unavailable_reason;
    use super::*;

    #[test]
    fn ax_focus_failure_reports_stage_trust_and_codes_without_target_data() {
        let reason = focus_unavailable_reason("delivery validation", -25205, -25204, true);
        assert!(reason.contains("delivery validation"));
        assert!(reason.contains("AX trusted=yes"));
        assert!(reason.contains("AXFocusedApplication=-25205"));
        assert!(reason.contains("AXFocusedUIElement=-25204"));
        assert!(!reason.contains("Notes"));
    }

    #[test]
    fn missing_focused_element_with_success_code_is_diagnostic() {
        let reason = focus_unavailable_reason("capture start", 0, 0, true);
        assert!(reason.contains("capture start"));
        assert!(reason.contains("AXFocusedUIElement=0 (null)"));
    }

    #[test]
    fn selected_text_failure_never_attempts_value_write() {
        let mut attrs = Vec::new();
        let result = insert_selected_text_with("dictation", |attr, text| {
            attrs.push((attr.to_string(), text.to_string()));
            Err("AX set failed".into())
        });
        assert!(result.is_err());
        assert_eq!(attrs, [("AXSelectedText".into(), "dictation".into())]);
    }
}
