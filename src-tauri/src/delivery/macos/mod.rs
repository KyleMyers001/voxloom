//! macOS Accessibility (AX) target snapshot + text insert.
//! Native/web fields try caret-aware AXSelectedText with exact read-back;
//! unchanged web fields alone may use verified Unicode fallback. Apple Terminal
//! uses a separate guarded Unicode-only path with explicit unverified dispatch
//! reporting: never AX-first, never scrollback verification, never auto-copy or
//! retry after events are posted. Secure/changed targets always refuse.
//! Other known terminals (WezTerm, iTerm2, ...) and Apple Messages take the clipboard paste route
//! (`paste_text`) instead of any AX write. Other native fields that AX
//! refuses without writing get one guarded ⌘V (`paste_after_refusal`, BUS-223).

mod ax;
mod ax_insert;
mod focus;
mod host;
mod keylayout;
mod paste;
mod pasteboard;
mod registry;
mod typing;
mod web_ax;
mod web_ctx;

use std::sync::Mutex;

use ax::{copy_string_attr, release, AXIsProcessTrusted, CFTypeRef};
use focus::{build_snapshot, edit_facts, focused_ui_element, snapshot_at};

use super::decide::diag::DeliveryDiag;
use super::decide::fallback::{
    after_ax_refusal, field_unchanged, in_web_content, may_paste, poll_readback, AxAttempt,
    PasteFacts, ValueStatus,
};
use super::decide::paste_target::{binding_for, check_paste_target};
use super::decide::report::PasteReport;
use super::decide::{
    check_insert_text, validate_snapshots, value_confirms_insert, InsertPath, InsertReport,
};
use super::types::{PasteBindingDto, TargetSnapshotDto};

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

/// `paste_fallback`: the Clipboard fallback setting. With it on, a native
/// field that AX refused without writing gets one guarded ⌘V (BUS-223).
pub fn insert_text(
    text: &str,
    intended: &TargetSnapshotDto,
    paste_fallback: bool,
) -> Result<InsertReport, String> {
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
    let started = std::time::Instant::now();
    // Validate the same element handle we will mutate, not a prior focus read.
    let (element, app_name) =
        focused_ui_element("insert").map_err(|e| format!("insert aborted — {e}"))?;
    let validated = validate_snapshots(intended, build_snapshot(element, app_name, false));
    let before = ax::read_value(element);
    let terminal = validated.app_pid.and_then(host::apple_terminal_identity);
    let mut diag = DeliveryDiag {
        bundle_id: validated.app_pid.and_then(host::bundle_id),
        role: validated.element_role.clone(),
        subrole: copy_string_attr(element, "AXSubrole"),
        value: before.label(),
        settable: edit_facts(element).label(),
        ..Default::default()
    };
    let path = super::decide::terminal::choose_path(&validated, before.text().is_some(), terminal);
    let terminal_path = path == InsertPath::TerminalUnicode;
    let mut attempt = AxAttempt::default();
    let result = match path {
        InsertPath::Refuse(reason) => {
            diag.gate = "refuse";
            Err(reason)
        }
        InsertPath::TerminalUnicode => {
            diag.gate = "terminal";
            typing::type_terminal(text, || terminal_still_matches(&validated, element))
        }
        InsertPath::AxSelectedText => {
            diag.gate = "ax";
            ax_insert::insert_selected(element, &validated, &before, text, &mut diag, &mut attempt)
        }
    };
    let result = if terminal_path {
        result // Apple Terminal never takes the ⌘V fallback.
    } else {
        let facts = PasteFacts {
            enabled: paste_fallback,
            apple_terminal: terminal,
            attempt,
            ..Default::default()
        };
        paste_after_refusal(result, element, &validated, &before, facts, text, &mut diag)
    };
    release(element as CFTypeRef);
    diag.total_ms = started.elapsed().as_millis();
    eprintln!("{}", diag.line());
    result
}

/// BUS-223 (c): one ⌘V when the AX path wrote nothing (`Err`, and only
/// write-free AX errors), under the terminal route's guards (same frontmost
/// pid, Secure Keyboard Entry off, change-count-guarded restore) plus the
/// same focused field, unchanged since `before_ax`. Read-back then decides
/// Inserted or "may have been inserted".
fn paste_after_refusal(
    ax: Result<InsertReport, String>,
    element: ax::AXUIElementRef,
    validated: &TargetSnapshotDto,
    before_ax: &ValueStatus,
    mut facts: PasteFacts,
    text: &str,
    diag: &mut DeliveryDiag,
) -> Result<InsertReport, String> {
    if ax.is_ok() {
        return ax; // Something was written (or proven inserted): never paste.
    }
    facts.known_terminal = host::terminal_flags(validated.app_pid).known;
    facts.web_host = validated
        .app_pid
        .and_then(host::web_ax_activation)
        .is_some();
    let role = validated.element_role.as_deref().unwrap_or_default();
    let has_dom_id = copy_string_attr(element, "AXDOMIdentifier").is_some();
    let ancestors = ax::ancestor_roles(element);
    facts.web_content = in_web_content(role, has_dom_id, &ancestors);
    let before = ax::read_value(element);
    facts.field_unchanged = field_unchanged(before_ax, &before);
    let gate = may_paste(validated, &facts, text);
    let pasted = std::time::Instant::now();
    let still_field: &dyn Fn() -> Result<(), String> = &|| focus_still_matches(validated);
    let result = after_ax_refusal(
        ax,
        gate,
        |pid| {
            let paster = paste::MacPaste {
                pid,
                still_field: Some(still_field),
            };
            super::decide::paste::paste_into_field(&paster, text)
        },
        || {
            let before_text = before.text().map(str::to_string);
            let after = poll_readback(
                &before,
                || ax::read_value(element),
                |ms| std::thread::sleep(std::time::Duration::from_millis(ms)),
            );
            match (before_text, after) {
                (Some(b), Some(a)) => value_confirms_insert(&b, &a, text),
                _ => false,
            }
        },
        diag,
    );
    diag.paste_ms = pasted.elapsed().as_millis();
    result
}

/// The paste-route app in front now, for `delivery_paste_binding`.
pub fn paste_binding() -> Option<PasteBindingDto> {
    let front = host::frontmost_pid();
    binding_for(front, front.and_then(host::paste_app))
}

/// Paste route (WezTerm, iTerm2, Messages, ...): clipboard + one ⌘V, then the
/// user's clipboard back. `bound` is the app that was in front when
/// dictation started: the frontmost process must be that same app (pid
/// and app path). `Err` = nothing pasted.
pub fn paste_text(text: &str, bound: &PasteBindingDto) -> Result<PasteReport, String> {
    let front = host::frontmost_pid();
    let front_app = front.and_then(host::paste_app);
    let pid = check_paste_target(bound, front, front_app.as_deref())?;
    // Held through the clipboard restore, so two inserts never interleave.
    let _serial = INSERT_LOCK
        .lock()
        .map_err(|_| "insert lock poisoned".to_string())?;
    let host = paste::MacPaste {
        pid,
        still_field: None,
    };
    let report = super::decide::paste::paste_text(&host, text)?;
    // Never the transcript: only that a paste went out and what became of the clipboard.
    eprintln!(
        "[paste] cmd-v posted to paste-route app; clipboard_restored={} reason={:?}",
        report.clipboard_restored, report.restore_skipped_reason
    );
    Ok(report)
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
