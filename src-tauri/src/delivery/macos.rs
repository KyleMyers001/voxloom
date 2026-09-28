//! macOS Accessibility (AX) target snapshot + text insert.
//! Use only caret-aware AXSelectedText; failures fall back to Copy in TS.
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

    fn CFStringCreateWithCString(
        alloc: CFTypeRef,
        c_str: *const i8,
        encoding: u32,
    ) -> CFStringRef;
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
}

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
        let err = unsafe {
            AXUIElementCopyAttributeValue(self.element, self.name, &mut value)
        };
        if err != AX_OK {
            return Err(err);
        }
        Ok(value)
    }
}

fn copy_string_attr(element: AXUIElementRef, attr: &str) -> Option<String> {
    let name = cfstr(attr);
    let result = AxAttr { element, name }.copy().ok().and_then(cfstring_to_rust);
    release(name);
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
        "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField" => {
            ("insertable", true, None)
        }
        // Browser / chat / editor surfaces — attempt insert; limitations documented.
        "AXWebArea" | "AXScrollArea" | "AXGroup" => (
            "insertable",
            true,
            Some("browser/chat surface — insert best-effort via AX"),
        ),
        // Terminals often expose AXTextArea already; unknown custom roles refuse.
        "AXStaticText" | "AXButton" | "AXImage" | "AXToolbar" | "AXMenu" => (
            "unsupported",
            false,
            Some("unsupported control role"),
        ),
        _ => (
            "unsupported",
            false,
            Some("unsupported or unknown AX role"),
        ),
    }
}

fn build_snapshot(element: AXUIElementRef, app_name: Option<String>) -> TargetSnapshotDto {
    let role = copy_string_attr(element, "AXRole").unwrap_or_else(|| "unknown".into());
    let pid = element_pid(element);
    let (kind, insertable, reason) = classify_role(&role);
    let element_id = Some(format!(
        "{}:{}:{}",
        pid.unwrap_or(-1),
        role,
        copy_string_attr(element, "AXDescription").unwrap_or_default()
    ));

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
            reason: Some(
                "Accessibility permission denied — insert skipped".into(),
            ),
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

fn focused_ui_element() -> Result<(AXUIElementRef, Option<String>), String> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        return Err("AXUIElementCreateSystemWide returned null".into());
    }

    let focused_app_attr = cfstr("AXFocusedApplication");
    let mut focused_app: CFTypeRef = ptr::null();
    let app_err = unsafe {
        AXUIElementCopyAttributeValue(system, focused_app_attr, &mut focused_app)
    };
    release(focused_app_attr);

    let app_name = if app_err == AX_OK && !focused_app.is_null() {
        let name = copy_string_attr(focused_app as AXUIElementRef, "AXTitle");
        name
    } else {
        None
    };

    let focused_attr = cfstr("AXFocusedUIElement");
    let mut focused: CFTypeRef = ptr::null();
    let focus_err = unsafe {
        AXUIElementCopyAttributeValue(system, focused_attr, &mut focused)
    };
    release(focused_attr);
    release(system);
    if !focused_app.is_null() {
        release(focused_app);
    }

    if focus_err != AX_OK || focused.is_null() {
        return Err(format!(
            "no focused UI element (AX error {focus_err}) — unsupported or empty AX tree"
        ));
    }

    Ok((focused as AXUIElementRef, app_name))
}

pub fn snapshot_target() -> Result<TargetSnapshotDto, String> {
    if unsafe { AXIsProcessTrusted() } == 0 {
        return Ok(TargetSnapshotDto::unavailable(
            "Accessibility permission denied — insert skipped",
            now_ms(),
        ));
    }

    match focused_ui_element() {
        Ok((element, app_name)) => {
            let snap = build_snapshot(element, app_name);
            release(element as CFTypeRef);
            Ok(snap)
        }
        Err(msg) => Ok(TargetSnapshotDto::unavailable(&msg, now_ms())),
    }
}

pub fn validate_target(
    intended: TargetSnapshotDto,
) -> Result<TargetSnapshotDto, String> {
    Ok(validate_snapshots(&intended, snapshot_target()?))
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

fn set_ax_string(
    element: AXUIElementRef,
    attr: &str,
    text: &str,
) -> Result<(), String> {
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

pub fn insert_text(text: &str, intended: &TargetSnapshotDto) -> Result<(), String> {
    if !intended.insertable || intended.kind != "insertable" {
        return Err(format!(
            "refusing insert into non-insertable target ({})",
            intended.kind
        ));
    }

    // Validate the same element handle we will mutate, not a prior focus read.
    let (element, app_name) = focused_ui_element()
        .map_err(|e| format!("insert aborted — {e}"))?;
    let validated = validate_snapshots(intended, build_snapshot(element, app_name));
    let result = if !validated.insertable || validated.kind != "insertable" {
        Err(format!(
            "refusing insert: {}",
            validated.reason.unwrap_or(validated.kind)
        ))
    } else {
        insert_selected_text_with(text, |attr, text| set_ax_string(element, attr, text))
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
            (target("insertable", Some(43), Some("43:AXTextArea:")), "changed"),
            (target("insertable", Some(42), Some("42:AXTextArea:other")), "changed"),
            (target("insertable", None, Some("-1:AXTextArea:")), "unavailable"),
        ] {
            let checked = validate_snapshots(&intended, current);
            assert!(!checked.insertable);
            assert_eq!(checked.kind, expected);
        }
        assert!(validate_snapshots(&intended, intended.clone()).insertable);
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
