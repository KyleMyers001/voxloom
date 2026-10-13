//! Focused-element lookup, snapshots and on-demand web AX enablement.

use std::time::{SystemTime, UNIX_EPOCH};

use super::ax::*;
use super::focus_fallback::frontmost_app_focus;
use super::{host, registry, web_ax};
use crate::delivery::decide::{classify_role, effective_role, element_token};
use crate::delivery::types::TargetSnapshotDto;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn focus_unavailable_reason(
    stage: &str,
    app_err: AXError,
    focus_err: AXError,
    null: bool,
) -> String {
    let null_suffix = if null { " (null)" } else { "" };
    format!(
        "Accessibility focus unavailable at {stage} (AX trusted=yes; \
         AXFocusedApplication={app_err}; AXFocusedUIElement={focus_err}{null_suffix})"
    )
}

fn copy_focus(system: AXUIElementRef) -> (AXError, CFTypeRef) {
    let name = cfstr("AXFocusedUIElement");
    let mut focused: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(system, name, &mut focused) };
    release(name);
    (err, focused)
}

/// Focused element (caller releases) and app name.
pub(super) fn focused_ui_element_once(
    stage: &str,
) -> Result<(AXUIElementRef, Option<String>), String> {
    let system = system_wide();
    if system.is_null() {
        return Err(format!(
            "Accessibility focus unavailable at {stage} (AX trusted=yes; system element null)"
        ));
    }
    let app = copy_attr(system, "AXFocusedApplication");
    let app_err = app.err().unwrap_or(AX_OK);
    let app_name = app
        .ok()
        .and_then(|a| copy_string_attr(a as AXUIElementRef, "AXTitle"));
    let (focus_err, focused) = copy_focus(system);
    if let Ok(app) = app {
        release(app);
    }
    release(system as CFTypeRef);
    if focus_err != AX_OK || focused.is_null() {
        let reason = focus_unavailable_reason(stage, app_err, focus_err, focused.is_null());
        release(focused);
        return frontmost_app_focus(&reason);
    }
    Ok((focused as AXUIElementRef, app_name))
}

/// Validation and per-chunk insertion guards never wait for web AX; only the
/// completion snapshot (`snapshot_at` with `register`) does.
pub fn focused_ui_element(stage: &str) -> Result<(AXUIElementRef, Option<String>), String> {
    focused_ui_element_once(stage)
}

pub fn build_snapshot(
    element: AXUIElementRef,
    app_name: Option<String>,
    register: bool,
) -> TargetSnapshotDto {
    let role = copy_string_attr(element, "AXRole").unwrap_or_else(|| "unknown".into());
    let pid = element_pid(element);
    let subrole = copy_string_attr(element, "AXSubrole");
    let (kind, insertable, reason) = classify_role(effective_role(&role, subrole.as_deref()));
    let generation = if register {
        registry::register(element)
    } else {
        registry::matching_generation(element)
    };
    let mut snap = TargetSnapshotDto {
        app_name,
        app_pid: pid,
        captured_at: now_ms(),
        element_id: Some(element_token(pid, &role, generation)),
        element_role: Some(role),
        insertable,
        kind: kind.into(),
        reason: reason.map(str::to_string),
    };
    if unsafe { AXIsProcessTrusted() } == 0 {
        snap.insertable = false;
        snap.kind = "unavailable".into();
        snap.reason = Some("Accessibility permission denied — insert skipped".into());
    }
    snap
}

pub fn snapshot_at(stage: &str, register: bool) -> TargetSnapshotDto {
    if unsafe { AXIsProcessTrusted() } == 0 {
        return TargetSnapshotDto::unavailable(
            &format!("Accessibility permission denied at {stage} — insert skipped"),
            now_ms(),
        );
    }
    if register {
        // Every completion (= insert attempt) re-asserts the Chromium/Electron
        // web AX attribute: apps can drop it while idle (see
        // docs/decisions/web-ax-reenable.md). Then, if focus is still a web
        // container, wait (bounded) for the real field in the SAME pid, which
        // must stay frontmost throughout.
        let front = host::frontmost_pid();
        web_ax::reassert(front);
        let focus = web_ax::settle_focus(stage, front, focused_ui_element_once(stage));
        return snapshot_from_focus(focus, true);
    }
    snapshot_from_focus(focused_ui_element(stage), false)
}

fn snapshot_from_focus(
    focus: Result<(AXUIElementRef, Option<String>), String>,
    register: bool,
) -> TargetSnapshotDto {
    match focus {
        Ok((element, app_name)) => {
            let snap = build_snapshot(element, app_name, register);
            release(element as CFTypeRef);
            snap
        }
        Err(msg) => TargetSnapshotDto::unavailable(&msg, now_ms()),
    }
}
