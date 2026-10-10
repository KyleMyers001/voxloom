//! macOS Accessibility (AX) target snapshot + text insert.
//! Native fields: caret-aware AXSelectedText, verified; failures fall back to Copy in TS.
//! Text fields inside web content (Chromium/Electron): ⌘V paste with clipboard restore.
//! Secure fields and identity mismatches refuse insert (Copy is TS-side).

use std::ffi::c_void;
use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};

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

fn classify_role(role: &str) -> (&'static str, bool, Option<&'static str>) {
    match role {
        "AXSecureTextField" => ("secure", false, Some("secure field — insert skipped")),
        "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField" => ("insertable", true, None),
        // Containers do not establish an editable caret. AXSelectedText may
        // return success here without changing the actual editor.
        "AXWebArea" | "AXScrollArea" | "AXGroup" => (
            "unsupported",
            false,
            Some("generic web/container role — insert unverified"),
        ),
        // Terminals often expose AXTextArea already; unknown custom roles refuse.
        "AXStaticText" | "AXButton" | "AXImage" | "AXToolbar" | "AXMenu" => {
            ("unsupported", false, Some("unsupported control role"))
        }
        _ => ("unsupported", false, Some("unsupported or unknown AX role")),
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

/// Identity distinguishing sibling fields that share role/description:
/// explicit identifiers plus on-screen position. Position shifts (scroll,
/// window move) make validation refuse, which is the fail-closed direction.
fn element_identity(element: AXUIElementRef, pid: Option<i32>, role: &str) -> String {
    let pos = copy_point_attr(element, "AXPosition")
        .map(|(x, y)| format!("{x},{y}"))
        .unwrap_or_default();
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        pid.unwrap_or(-1),
        role,
        copy_string_attr(element, "AXIdentifier").unwrap_or_default(),
        copy_string_attr(element, "AXDOMIdentifier").unwrap_or_default(),
        copy_string_attr(element, "AXTitle").unwrap_or_default(),
        copy_string_attr(element, "AXDescription").unwrap_or_default(),
        pos
    )
}

fn build_snapshot(element: AXUIElementRef, app_name: Option<String>) -> TargetSnapshotDto {
    let role = copy_string_attr(element, "AXRole").unwrap_or_else(|| "unknown".into());
    let pid = element_pid(element);
    let subrole = copy_string_attr(element, "AXSubrole");
    // Password fields keep role AXTextField; the subrole marks them secure.
    let effective_role = if subrole.as_deref() == Some("AXSecureTextField") {
        "AXSecureTextField"
    } else {
        role.as_str()
    };
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
        enable_manual_accessibility(focused_app as AXUIElementRef);
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

fn validate_snapshots(
    intended: &TargetSnapshotDto,
    current: TargetSnapshotDto,
) -> TargetSnapshotDto {
    // Missing AX focus is not evidence that the original application closed.
    if current.kind == "unavailable" || current.kind == "secure" || !current.insertable {
        return current;
    }
    if intended.kind != "insertable" || !intended.insertable {
        return intended.clone();
    }

    match (intended.app_pid, current.app_pid) {
        (Some(want), Some(have)) if want != have => {
            return TargetSnapshotDto {
                insertable: false,
                kind: "changed".into(),
                reason: Some("target changed (different app)".into()),
                ..current
            };
        }
        (Some(_), Some(_)) => {}
        _ => {
            return TargetSnapshotDto {
                insertable: false,
                kind: "unavailable".into(),
                reason: Some("target identity unavailable — insert skipped".into()),
                ..current
            };
        }
    }
    match (intended.element_id.as_ref(), current.element_id.as_ref()) {
        (Some(want), Some(have)) if want != have => TargetSnapshotDto {
            insertable: false,
            kind: "changed".into(),
            reason: Some("target changed (different field)".into()),
            ..current
        },
        (Some(_), Some(_)) => current,
        _ => TargetSnapshotDto {
            insertable: false,
            kind: "unavailable".into(),
            reason: Some("target identity unavailable — insert skipped".into()),
            ..current
        },
    }
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

fn value_confirms_insert(before: &str, after: &str, text: &str) -> bool {
    !text.is_empty() && before != after && after.contains(text)
}

fn insert_selected_text_with(
    text: &str,
    set: impl FnOnce(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    // AXValue replaces the entire field; a failed selected-text set must not
    // try another AX mutation. The caller will use the Copy/Failed policy.
    set("AXSelectedText", text)
}

fn enable_manual_accessibility(app: AXUIElementRef) {
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
    let mut child = Command::new(cmd)
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

/// Paste (⌘V only — no Enter/Tab) with best-effort plain-text clipboard restore.
fn paste_text(text: &str) -> Result<(), String> {
    let previous = run_pb("pbpaste", None);
    run_pb("pbcopy", Some(text)).ok_or("clipboard write failed")?;
    std::thread::sleep(std::time::Duration::from_millis(40));
    let result = post_cmd_v();
    // Give the target app time to read the pasteboard before restoring.
    std::thread::sleep(std::time::Duration::from_millis(250));
    // Restore only if the clipboard still holds our transcript; if the user
    // copied something during the delay, keep their newer content.
    if let Some(prev) = previous {
        if run_pb("pbpaste", None).as_deref() == Some(text) {
            let _ = run_pb("pbcopy", Some(&prev));
        } else {
            eprintln!("[delivery] clipboard changed during paste — restore skipped");
        }
    }
    result
}

fn role_has_web_ancestor(element: AXUIElementRef) -> bool {
    let parent_attr = cfstr("AXParent");
    let mut current: CFTypeRef = ptr::null();
    let mut cursor = element;
    let mut found = false;
    for _ in 0..32 {
        let mut parent: CFTypeRef = ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(cursor, parent_attr, &mut parent) };
        if err != AX_OK || parent.is_null() {
            break;
        }
        release(current);
        current = parent;
        cursor = parent as AXUIElementRef;
        if copy_string_attr(cursor, "AXRole").as_deref() == Some("AXWebArea") {
            found = true;
            break;
        }
    }
    release(current);
    release(parent_attr);
    found
}

/// Editable fields hosted in web content: AX writes report success without
/// reaching the DOM, so these use ⌘V paste instead of AXSelectedText.
fn is_web_content_field(element: AXUIElementRef) -> bool {
    copy_string_attr(element, "AXDOMIdentifier").is_some() || role_has_web_ancestor(element)
}

pub fn insert_text(text: &str, intended: &TargetSnapshotDto) -> Result<(), String> {
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
    let result = if !validated.insertable || validated.kind != "insertable" {
        Err(format!(
            "refusing insert: {}",
            validated.reason.unwrap_or(validated.kind)
        ))
    } else if is_web_content_field(element) {
        paste_text(text)
    } else if let Some(before) = copy_string_attr(element, "AXValue") {
        match insert_selected_text_with(text, |attr, text| set_ax_string(element, attr, text)) {
            Ok(()) => match copy_string_attr(element, "AXValue") {
                Some(after) if value_confirms_insert(&before, &after, text) => Ok(()),
                _ => Err("AXSelectedText returned success but insertion could not be verified via AXValue".into()),
            },
            Err(err) => Err(err),
        }
    } else {
        Err("AXValue unreadable before insert — insert skipped".into())
    };

    release(element as CFTypeRef);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(kind: &str, pid: Option<i32>, id: Option<&str>) -> TargetSnapshotDto {
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

    #[test]
    fn unavailable_focus_is_not_evidence_of_app_closure() {
        let checked = validate_snapshots(
            &target("insertable", Some(42), Some("42:AXTextArea:")),
            target("unavailable", None, None),
        );
        assert_eq!(checked.kind, "unavailable");
        assert_eq!(
            checked.reason.as_deref(),
            Some("Accessibility permission denied — insert skipped")
        );
    }

    #[test]
    fn changed_or_unidentifiable_target_is_not_insertable() {
        let intended = target("insertable", Some(42), Some("42:AXTextArea:"));
        for (current, expected) in [
            (
                target("insertable", Some(43), Some("43:AXTextArea:")),
                "changed",
            ),
            (
                target("insertable", Some(42), Some("42:AXTextArea:other")),
                "changed",
            ),
            (
                target("insertable", None, Some("-1:AXTextArea:")),
                "unavailable",
            ),
        ] {
            let checked = validate_snapshots(&intended, current);
            assert!(!checked.insertable);
            assert_eq!(checked.kind, expected);
        }
        assert!(validate_snapshots(&intended, intended.clone()).insertable);
    }

    #[test]
    fn generic_web_containers_never_claim_insertability() {
        for role in ["AXWebArea", "AXScrollArea", "AXGroup"] {
            let (kind, insertable, _) = classify_role(role);
            assert_eq!(kind, "unsupported");
            assert!(!insertable);
        }
        assert!(classify_role("AXTextArea").1);
    }

    #[test]
    fn insertion_requires_readback_change_containing_transcript() {
        assert!(value_confirms_insert("hello", "hello world", " world"));
        assert!(value_confirms_insert("old line", "new line", "new line"));
        assert!(!value_confirms_insert("hello", "hello", " world"));
        assert!(!value_confirms_insert("hello", "hello!", " world"));
        assert!(!value_confirms_insert("hello", "hello!", ""));
    }

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
