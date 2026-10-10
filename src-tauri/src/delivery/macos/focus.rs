//! Focused-element lookup, snapshots and on-demand web AX enablement.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::ax::*;
use super::registry;
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

/// Pids where AXManualAccessibility was set successfully. Never reverted:
/// Chromium/Electron keep the full AX tree for the app lifetime. Only set when
/// focus is an opaque web container, and only cached on AX success so a busy
/// browser is retried. The tree builds asynchronously, so the first dictation
/// right after enabling may still see a container and fall back to Copy.
static MANUAL_AX: Mutex<Option<HashSet<i32>>> = Mutex::new(None);

fn enable_web_ax_if_opaque(app: AXUIElementRef, focused_role: &str) -> bool {
    if !matches!(focused_role, "AXWebArea" | "AXGroup" | "AXScrollArea") {
        return false;
    }
    let Some(pid) = element_pid(app) else {
        return false;
    };
    let Ok(mut guard) = MANUAL_AX.lock() else {
        return false;
    };
    let set = guard.get_or_insert_with(HashSet::new);
    if set.contains(&pid) || !set_manual_accessibility(app) {
        return false;
    }
    set.insert(pid);
    true
}

fn copy_focus(system: AXUIElementRef) -> (AXError, CFTypeRef) {
    let name = cfstr("AXFocusedUIElement");
    let mut focused: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(system, name, &mut focused) };
    release(name);
    (err, focused)
}

/// Focused element (caller releases) and app name.
pub fn focused_ui_element(stage: &str) -> Result<(AXUIElementRef, Option<String>), String> {
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
    let (mut focus_err, mut focused) = copy_focus(system);
    if let (Ok(app), true) = (app, focus_err == AX_OK && !focused.is_null()) {
        let role = copy_string_attr(focused as AXUIElementRef, "AXRole").unwrap_or_default();
        if enable_web_ax_if_opaque(app as AXUIElementRef, &role) {
            release(focused);
            (focus_err, focused) = copy_focus(system);
        }
    }
    if let Ok(app) = app {
        release(app);
    }
    release(system as CFTypeRef);
    if focus_err != AX_OK || focused.is_null() {
        let reason = focus_unavailable_reason(stage, app_err, focus_err, focused.is_null());
        release(focused);
        return Err(reason);
    }
    Ok((focused as AXUIElementRef, app_name))
}

/// Snapshot `element`; `register` retains it as the intended target.
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
    match focused_ui_element(stage) {
        Ok((element, app_name)) => {
            let snap = build_snapshot(element, app_name, register);
            release(element as CFTypeRef);
            snap
        }
        Err(msg) => TargetSnapshotDto::unavailable(&msg, now_ms()),
    }
}
