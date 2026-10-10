//! macOS Accessibility (AX) target snapshot + text insert.
//! Native fields: caret-aware AXSelectedText, verified; failures fall back to Copy in TS.
//! Text fields inside web content (Chromium/Electron): ⌘V paste with clipboard restore.
//! Secure fields and identity mismatches refuse insert (Copy is TS-side).

use std::ffi::c_void;
use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};

use super::decide::{
    check_insert_text, choose_insert_path, classify_clipboard, classify_role, effective_role,
    element_identity as identity_string, is_web_content_field, restore_decision,
    validate_snapshots, value_confirms_insert, IdentityParts, InsertPath, InsertReport,
    RestoreDecision, UNVERIFIED_PASTE,
};
use super::types::TargetSnapshotDto;

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type AXUIElementRef = *mut c_void;
type AXError = i32;
type pid_t = i32;

const AX_OK: AXError = 0;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

#[link(name = "ApplicationServices", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut pid_t) -> AXError;
    fn AXIsProcessTrusted() -> u8;

    fn CFStringCreateWithCString(alloc: CFTypeRef, c_str: *const i8, encoding: u32) -> CFStringRef;
    fn CFStringGetCString(
        the_string: CFStringRef,
        buffer: *mut i8,
        buffer_size: isize,
        encoding: u32,
    ) -> u8;
    fn CFStringGetLength(the_string: CFStringRef) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFRelease(cf: CFTypeRef);
    static kCFBooleanTrue: CFTypeRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state_id: i32) -> CFTypeRef;
    fn CGEventCreateKeyboardEvent(source: CFTypeRef, keycode: u16, keydown: bool) -> CFTypeRef;
    fn CGEventSetFlags(event: CFTypeRef, flags: u64);
    fn CGEventPost(tap: u32, event: CFTypeRef);
}

const KEYCODE_V: u16 = 9;
const FLAG_COMMAND: u64 = 0x0010_0000;
const HID_EVENT_TAP: u32 = 0;
const SOURCE_HID_SYSTEM_STATE: i32 = 1;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn cfstr(s: &str) -> CFStringRef {
    let c = std::ffi::CString::new(s).unwrap_or_default();
    unsafe { CFStringCreateWithCString(ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8) }
}

fn cfstring_to_rust(cf: CFStringRef) -> Option<String> {
    if cf.is_null() {
        return None;
    }
    unsafe {
        if CFGetTypeID(cf) != CFStringGetTypeID() {
            return None;
        }
        let len = CFStringGetLength(cf);
        let size = CFStringGetMaximumSizeForEncoding(len, K_CF_STRING_ENCODING_UTF8) + 1;
        if size <= 1 {
            return Some(String::new());
        }
        let mut buf = vec![0i8; size as usize];
        let ok = CFStringGetCString(cf, buf.as_mut_ptr(), size, K_CF_STRING_ENCODING_UTF8);
        if ok == 0 {
            return None;
        }
        let cstr = std::ffi::CStr::from_ptr(buf.as_ptr());
        Some(cstr.to_string_lossy().into_owned())
    }
}

fn release(cf: CFTypeRef) {
    if !cf.is_null() {
        unsafe { CFRelease(cf) }
    }
}

struct AxAttr {
    element: AXUIElementRef,
    name: CFStringRef,
}

impl AxAttr {
    fn copy(&self) -> Result<CFTypeRef, AXError> {
        let mut value: CFTypeRef = ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(self.element, self.name, &mut value) };
        if err != AX_OK {
            release(value);
            return Err(err);
        }
        Ok(value)
    }
}

fn copy_string_attr(element: AXUIElementRef, attr: &str) -> Option<String> {
    let name = cfstr(attr);
    let copied = AxAttr { element, name }.copy();
    release(name);
    let value = copied.ok()?;
    // CopyAttributeValue transfers ownership even if conversion returns None.
    let result = cfstring_to_rust(value);
    release(value);
    result
}

fn element_pid(element: AXUIElementRef) -> Option<i32> {
    let mut pid: pid_t = 0;
    let err = unsafe { AXUIElementGetPid(element, &mut pid) };
    if err == AX_OK {
        Some(pid)
    } else {
        None
    }
}

#[repr(C)]
#[derive(Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

const K_AX_VALUE_CG_POINT_TYPE: u32 = 1;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> u8;
}

fn copy_point_attr(element: AXUIElementRef, attr: &str) -> Option<(i64, i64)> {
    let name = cfstr(attr);
    let value = AxAttr { element, name }.copy().ok();
    release(name);
    let value = value?;
    let mut pt = CGPoint::default();
    let ok = unsafe {
        AXValueGetValue(
            value,
            K_AX_VALUE_CG_POINT_TYPE,
            &mut pt as *mut CGPoint as *mut c_void,
        )
    };
    release(value);
    (ok != 0).then(|| (pt.x.round() as i64, pt.y.round() as i64))
}

fn element_identity(element: AXUIElementRef, pid: Option<i32>, role: &str) -> String {
    let identifier = copy_string_attr(element, "AXIdentifier");
    let dom_identifier = copy_string_attr(element, "AXDOMIdentifier");
    let title = copy_string_attr(element, "AXTitle");
    let description = copy_string_attr(element, "AXDescription");
    identity_string(&IdentityParts {
        pid,
        role,
        identifier: identifier.as_deref(),
        dom_identifier: dom_identifier.as_deref(),
        title: title.as_deref(),
        description: description.as_deref(),
        position: copy_point_attr(element, "AXPosition"),
    })
}

fn build_snapshot(element: AXUIElementRef, app_name: Option<String>) -> TargetSnapshotDto {
    let role = copy_string_attr(element, "AXRole").unwrap_or_else(|| "unknown".into());
    let pid = element_pid(element);
    let subrole = copy_string_attr(element, "AXSubrole");
    let effective_role = effective_role(&role, subrole.as_deref());
    let (kind, insertable, reason) = classify_role(effective_role);
    let element_id = Some(element_identity(element, pid, &role));

    // Trusted process check — if Accessibility is denied, refuse insert.
    let trusted = unsafe { AXIsProcessTrusted() } != 0;
    if !trusted {
        return TargetSnapshotDto {
            app_name,
            app_pid: pid,
            captured_at: now_ms(),
            element_id,
            element_role: Some(role),
            insertable: false,
            kind: "unavailable".into(),
            reason: Some("Accessibility permission denied — insert skipped".into()),
        };
    }

    TargetSnapshotDto {
        app_name,
        app_pid: pid,
        captured_at: now_ms(),
        element_id,
        element_role: Some(role),
        insertable,
        kind: kind.into(),
        reason: reason.map(str::to_string),
    }
}

fn focus_unavailable_reason(
    stage: &str,
    app_err: AXError,
    focus_err: AXError,
    focus_null: bool,
) -> String {
    let null_suffix = if focus_null { " (null)" } else { "" };
    format!(
        "Accessibility focus unavailable at {stage} (AX trusted=yes; \
         AXFocusedApplication={app_err}; AXFocusedUIElement={focus_err}{null_suffix})"
    )
}

fn focused_ui_element(stage: &str) -> Result<(AXUIElementRef, Option<String>), String> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        return Err(format!(
            "Accessibility focus unavailable at {stage} (AX trusted=yes; system element null)"
        ));
    }

    let focused_app_attr = cfstr("AXFocusedApplication");
    let mut focused_app: CFTypeRef = ptr::null();
    let app_err =
        unsafe { AXUIElementCopyAttributeValue(system, focused_app_attr, &mut focused_app) };
    release(focused_app_attr);

    let app_name = if app_err == AX_OK && !focused_app.is_null() {
        // Chromium/Electron only expose web-content fields to AX once a client
        // requests it; without this the focus is an opaque AXWebArea/AXGroup.
        enable_manual_accessibility_once(focused_app as AXUIElementRef);
        let name = copy_string_attr(focused_app as AXUIElementRef, "AXTitle");
        name
    } else {
        None
    };

    let focused_attr = cfstr("AXFocusedUIElement");
    let mut focused: CFTypeRef = ptr::null();
    let focus_err = unsafe { AXUIElementCopyAttributeValue(system, focused_attr, &mut focused) };
    release(focused_attr);
    release(system);
    if !focused_app.is_null() {
        release(focused_app);
    }

    if focus_err != AX_OK || focused.is_null() {
        let reason = focus_unavailable_reason(stage, app_err, focus_err, focused.is_null());
        if !focused.is_null() {
            release(focused);
        }
        return Err(reason);
    }

    Ok((focused as AXUIElementRef, app_name))
}

pub fn snapshot_target() -> Result<TargetSnapshotDto, String> {
    snapshot_target_at("capture start")
}

fn snapshot_target_at(stage: &str) -> Result<TargetSnapshotDto, String> {
    if unsafe { AXIsProcessTrusted() } == 0 {
        return Ok(TargetSnapshotDto::unavailable(
            &format!("Accessibility permission denied at {stage} — insert skipped"),
            now_ms(),
        ));
    }

    match focused_ui_element(stage) {
        Ok((element, app_name)) => {
            let snap = build_snapshot(element, app_name);
            release(element as CFTypeRef);
            Ok(snap)
        }
        Err(msg) => Ok(TargetSnapshotDto::unavailable(&msg, now_ms())),
    }
}

pub fn validate_target(intended: TargetSnapshotDto) -> Result<TargetSnapshotDto, String> {
    Ok(validate_snapshots(
        &intended,
        snapshot_target_at("delivery validation")?,
    ))
}

fn set_ax_string(element: AXUIElementRef, attr: &str, text: &str) -> Result<(), String> {
    let name = cfstr(attr);
    let value = cfstr(text);
    let err = unsafe { AXUIElementSetAttributeValue(element, name, value) };
    release(name);
    release(value);
    if err != AX_OK {
        return Err(format!("AX set {attr} failed (error {err})"));
    }
    Ok(())
}

fn insert_selected_text_with(
    text: &str,
    set: impl FnOnce(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    // AXValue replaces the entire field; a failed selected-text set must not
    // try another AX mutation. The caller will use the Copy/Failed policy.
    set("AXSelectedText", text)
}

/// Set AXManualAccessibility once per app pid. It is intentionally never
/// reverted: Chromium/Electron keep their full AX tree for the app lifetime
/// (CPU/memory cost). The tree builds asynchronously, so the very first
/// dictation into a freshly-enabled browser may still see AXWebArea/AXGroup
/// and fall back to Copy; later ones insert.
fn enable_manual_accessibility_once(app: AXUIElementRef) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static ENABLED: OnceLock<Mutex<HashSet<i32>>> = OnceLock::new();
    let Some(pid) = element_pid(app) else {
        return;
    };
    let set = ENABLED.get_or_init(|| Mutex::new(HashSet::new()));
    let first_time = set.lock().map(|mut seen| seen.insert(pid)).unwrap_or(false);
    if !first_time {
        return;
    }
    let name = cfstr("AXManualAccessibility");
    // Errors are expected for non-Chromium apps; ignore.
    unsafe {
        let _ = AXUIElementSetAttributeValue(app, name, kCFBooleanTrue);
    }
    release(name);
}

fn run_pb(cmd: &str, input: Option<&str>) -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    // GUI-launched apps often have no LANG/LC_CTYPE; without it pbcopy/pbpaste
    // use a legacy encoding and garble non-ASCII (é, emoji, CJK).
    let mut child = Command::new(cmd)
        .env("LC_CTYPE", "UTF-8")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(text) = input {
        child.stdin.take()?.write_all(text.as_bytes()).ok()?;
    } else {
        drop(child.stdin.take());
    }
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Pasteboard flavors via AppleScript `clipboard info` (e.g.
/// `«class PNGf», 1234, string, 5`). Lets us tell image/file/rich clipboards
/// apart from plain text, which pbpaste alone cannot (it prints "" for them).
fn clipboard_info() -> Option<String> {
    let out = std::process::Command::new("osascript")
        .args(["-e", "clipboard info"])
        .env("LC_CTYPE", "UTF-8")
        .env("LANG", "en_US.UTF-8")
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn post_cmd_v() -> Result<(), String> {
    unsafe {
        let source = CGEventSourceCreate(SOURCE_HID_SYSTEM_STATE);
        let down = CGEventCreateKeyboardEvent(source, KEYCODE_V, true);
        let up = CGEventCreateKeyboardEvent(source, KEYCODE_V, false);
        if down.is_null() || up.is_null() {
            release(down);
            release(up);
            release(source);
            return Err("could not create paste key events".into());
        }
        CGEventSetFlags(down, FLAG_COMMAND);
        CGEventSetFlags(up, FLAG_COMMAND);
        CGEventPost(HID_EVENT_TAP, down);
        CGEventPost(HID_EVENT_TAP, up);
        release(down);
        release(up);
        release(source);
    }
    Ok(())
}

/// Paste (⌘V only — no Enter/Tab) into the validated element, then restore
/// the prior clipboard only if it was plain text and still holds our transcript.
/// Non-text priors (image/file/rich) are detected up front and never "restored"
/// as an empty/lossy string; the skip is reported instead.
///
/// Known limit (documented TOCTOU): `still_target` re-checks focus immediately
/// before CGEventPost, which targets whatever is focused rather than a specific
/// element. A focus change in the few ms between the check and the post is not
/// caught. Keep nothing between the check and the post.
fn paste_text(
    text: &str,
    still_target: impl Fn() -> Result<(), String>,
) -> (Result<(), String>, InsertReport) {
    let mut report = InsertReport {
        pasted: true,
        ..Default::default()
    };
    let prior = classify_clipboard(
        clipboard_info().as_deref(),
        run_pb("pbpaste", None).as_deref(),
    );
    if run_pb("pbcopy", Some(text)).is_none() {
        report.pasted = false;
        return (Err("clipboard write failed — paste skipped".into()), report);
    }
    std::thread::sleep(std::time::Duration::from_millis(40));
    let result = still_target().and_then(|()| post_cmd_v());
    if result.is_err() {
        report.pasted = false;
    } else {
        // Give the target app time to read the pasteboard before restoring.
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let now = run_pb("pbpaste", None);
    match restore_decision(&prior, now.as_deref(), text) {
        RestoreDecision::Restore(prev) => {
            if run_pb("pbcopy", Some(&prev)).is_some() {
                report.clipboard_restored = true;
            } else {
                report.restore_skipped_reason = Some("restore write failed".into());
            }
        }
        RestoreDecision::Skip(reason) => report.restore_skipped_reason = Some(reason.into()),
    }
    (result, report)
}

fn ancestor_roles(element: AXUIElementRef) -> Vec<String> {
    let parent_attr = cfstr("AXParent");
    let mut roles = Vec::new();
    let mut current: CFTypeRef = ptr::null();
    let mut cursor = element;
    for _ in 0..32 {
        let mut parent: CFTypeRef = ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(cursor, parent_attr, &mut parent) };
        if err != AX_OK || parent.is_null() {
            break;
        }
        release(current);
        current = parent;
        cursor = parent as AXUIElementRef;
        let role = copy_string_attr(cursor, "AXRole").unwrap_or_default();
        let stop = role == "AXWebArea";
        roles.push(role);
        if stop {
            break;
        }
    }
    release(current);
    release(parent_attr);
    roles
}

/// Re-read focus and require it to still be the validated, insertable field.
fn focus_still_matches(intended: &TargetSnapshotDto) -> Result<(), String> {
    let (element, app_name) =
        focused_ui_element("paste dispatch").map_err(|e| format!("paste aborted — {e}"))?;
    let checked = validate_snapshots(intended, build_snapshot(element, app_name));
    release(element as CFTypeRef);
    if checked.insertable && checked.kind == "insertable" {
        Ok(())
    } else {
        Err(format!(
            "paste aborted — focus changed: {}",
            checked.reason.unwrap_or(checked.kind)
        ))
    }
}

pub fn insert_text(text: &str, intended: &TargetSnapshotDto) -> Result<InsertReport, String> {
    check_insert_text(text)?;
    if !intended.insertable || intended.kind != "insertable" {
        return Err(format!(
            "refusing insert into non-insertable target ({})",
            intended.kind
        ));
    }

    // Validate the same element handle we will mutate, not a prior focus read.
    if unsafe { AXIsProcessTrusted() } == 0 {
        return Err("Accessibility permission denied at insert — insert skipped".into());
    }
    let (element, app_name) =
        focused_ui_element("insert").map_err(|e| format!("insert aborted — {e}"))?;
    let validated = validate_snapshots(intended, build_snapshot(element, app_name));
    let role = validated.element_role.clone().unwrap_or_default();
    let is_web = validated.insertable
        && is_web_content_field(
            &role,
            copy_string_attr(element, "AXDOMIdentifier").is_some(),
            &ancestor_roles(element),
        );
    let before = copy_string_attr(element, "AXValue");
    let unverified = || -> Result<InsertReport, String> {
        Err("insertion could not be verified via AXValue read-back".into())
    };

    let result = match choose_insert_path(&validated, is_web, before.is_some()) {
        InsertPath::Refuse(reason) => Err(reason),
        InsertPath::WebPaste => {
            let before = before.unwrap_or_default();
            let (pasted, report) = paste_text(text, || focus_still_matches(&validated));
            match pasted {
                Err(err) => Err(match &report.restore_skipped_reason {
                    Some(r) => format!("{err} (clipboard not restored: {r})"),
                    None => err,
                }),
                Ok(()) => match copy_string_attr(element, "AXValue") {
                    Some(after) if value_confirms_insert(&before, &after, text) => Ok(report),
                    _ => Err(format!(
                        "{UNVERIFIED_PASTE}{}",
                        report
                            .restore_skipped_reason
                            .as_deref()
                            .map(|r| format!(" (clipboard not restored: {r})"))
                            .unwrap_or_default()
                    )),
                },
            }
        }
        InsertPath::AxSelectedText => {
            let before = before.unwrap_or_default();
            match insert_selected_text_with(text, |attr, text| set_ax_string(element, attr, text)) {
                Ok(()) => match copy_string_attr(element, "AXValue") {
                    Some(after) if value_confirms_insert(&before, &after, text) => {
                        Ok(InsertReport::default())
                    }
                    _ => unverified(),
                },
                Err(err) => Err(err),
            }
        }
    };

    release(element as CFTypeRef);
    result
}

#[cfg(test)]
mod tests {
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
