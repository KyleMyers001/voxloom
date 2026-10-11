//! macOS Accessibility (AX) target snapshot + text insert.
//! Native/web fields try caret-aware AXSelectedText with exact read-back;
//! unchanged web fields alone may use verified Unicode fallback. Apple Terminal
//! uses a separate guarded Unicode-only path with explicit unverified dispatch
//! reporting: never AX-first, never scrollback verification, never auto-copy or
//! retry after events are posted. Secure/changed targets always refuse.

mod ax;
mod ax_insert;
mod focus;
mod host;
mod registry;
mod typing;
mod unreadable;
mod web_ax;
mod web_ctx;

use std::sync::Mutex;

use ax::{copy_string_attr, release, AXIsProcessTrusted, CFTypeRef};
use focus::{build_snapshot, focused_ui_element, snapshot_at};

use super::decide::{check_insert_text, validate_snapshots, InsertPath, InsertReport};
use super::types::TargetSnapshotDto;

/// Serializes inserts (commands run off the main thread and may overlap).
static INSERT_LOCK: Mutex<()> = Mutex::new(());

pub fn snapshot_target() -> Result<TargetSnapshotDto, String> {
    Ok(snapshot_at("transcription completion", true))
}

pub fn validate_target(intended: TargetSnapshotDto) -> Result<TargetSnapshotDto, String> {
    Ok(validate_snapshots(
        &intended,
        snapshot_at("delivery validation", false),
    ))
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

/// Fail closed on any change: native CFEqual identity, trust, system host,
/// independent foreground PID and the observed text-area/window shape.
fn terminal_still_matches(
    intended: &TargetSnapshotDto,
    element: ax::AXUIElementRef,
) -> Result<(), String> {
    let pid = intended.app_pid.ok_or("Terminal PID unavailable")?;
    if unsafe { AXIsProcessTrusted() } == 0
        || !host::apple_terminal(pid)
        || host::frontmost_pid() != Some(pid)
    {
        return Err("Terminal trust, host or foreground changed".into());
    }
    focus_still_matches(intended)?;
    let window =
        ax::copy_attr(element, "AXWindow").map_err(|_| "Terminal text-area window unavailable")?;
    let shape_ok = copy_string_attr(element, "AXRole").as_deref() == Some("AXTextArea")
        && copy_string_attr(element, "AXSubrole").as_deref() != Some("AXSecureTextField")
        && copy_string_attr(window as ax::AXUIElementRef, "AXRole").as_deref() == Some("AXWindow")
        && ax::element_pid(window as ax::AXUIElementRef) == Some(pid);
    release(window);
    if !shape_ok {
        return Err("unsupported Terminal text-area/window shape".into());
    }
    // Recheck foreground after AX reads, immediately before posting. There is
    // still an unavoidable check/post race; this does not atomically bind CGEvents.
    if host::frontmost_pid() != Some(pid) {
        return Err("Terminal foreground changed".into());
    }
    Ok(())
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
    let terminal = validated.app_pid.and_then(host::apple_terminal_identity);
    let messages_host = super::decide::messages::unreadable_value_allowed(
        validated.app_pid.and_then(host::bundle_id).as_deref(),
    );
    let path =
        super::decide::terminal::choose_path(&validated, before.is_some(), messages_host, terminal);
    let result = match path {
        InsertPath::Refuse(reason) => Err(reason),
        InsertPath::MessagesGuarded => unreadable::insert_without_value(element, &validated, text),
        InsertPath::TerminalUnicode => {
            typing::type_terminal(text, || terminal_still_matches(&validated, element))
        }
        InsertPath::AxSelectedText => {
            ax_insert::insert_selected(element, &validated, before.unwrap_or_default(), text)
        }
    };
    release(element as CFTypeRef);
    result
}

#[cfg(test)]
mod tests {
    use super::focus::focus_unavailable_reason;

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
}
