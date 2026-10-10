//! Thin AX / CoreFoundation FFI helpers (no policy here).

use std::ffi::c_void;
use std::ptr;

pub type CFTypeRef = *const c_void;
pub type CFStringRef = *const c_void;
pub type AXUIElementRef = *mut c_void;
pub type AXError = i32;
#[allow(non_camel_case_types)]
type pid_t = i32;

pub const AX_OK: AXError = 0;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

#[link(name = "ApplicationServices", kind = "framework")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    pub fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    pub fn AXUIElementCopyAttributeValue(
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
    pub fn AXIsProcessTrusted() -> u8;

    fn CFStringCreateWithCString(alloc: CFTypeRef, c_str: *const i8, encoding: u32) -> CFStringRef;
    fn CFStringGetCString(s: CFStringRef, buf: *mut i8, size: isize, encoding: u32) -> u8;
    fn CFStringGetLength(s: CFStringRef) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFRelease(cf: CFTypeRef);
    pub fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    pub fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> u8;
    static kCFBooleanTrue: CFTypeRef;
}

/// Callers must only pass strings already checked for interior NULs.
pub fn cfstr(s: &str) -> CFStringRef {
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
        if CFStringGetCString(cf, buf.as_mut_ptr(), size, K_CF_STRING_ENCODING_UTF8) == 0 {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr(buf.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    }
}

pub fn release(cf: CFTypeRef) {
    if !cf.is_null() {
        unsafe { CFRelease(cf) }
    }
}

/// Copy an attribute; caller owns (and must release) a non-null result.
pub fn copy_attr(element: AXUIElementRef, attr: &str) -> Result<CFTypeRef, AXError> {
    let name = cfstr(attr);
    let mut value: CFTypeRef = ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(element, name, &mut value) };
    release(name);
    if err != AX_OK || value.is_null() {
        release(value);
        return Err(if err != AX_OK { err } else { -1 });
    }
    Ok(value)
}

pub fn copy_string_attr(element: AXUIElementRef, attr: &str) -> Option<String> {
    let value = copy_attr(element, attr).ok()?;
    let result = cfstring_to_rust(value);
    release(value);
    result
}

pub fn element_pid(element: AXUIElementRef) -> Option<i32> {
    let mut pid: pid_t = 0;
    (unsafe { AXUIElementGetPid(element, &mut pid) } == AX_OK).then_some(pid)
}

pub fn set_ax_string(element: AXUIElementRef, attr: &str, text: &str) -> Result<(), String> {
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

/// Request the host-specific activation; preserve errors, including unsupported.
pub fn set_web_accessibility(
    app: AXUIElementRef,
    activation: crate::delivery::decide::host::WebAxActivation,
) -> AXError {
    let name = cfstr(activation.attribute());
    let err = unsafe { AXUIElementSetAttributeValue(app, name, kCFBooleanTrue) };
    release(name);
    err
}

/// System-wide element; caller releases.
pub fn system_wide() -> AXUIElementRef {
    unsafe { AXUIElementCreateSystemWide() }
}

/// Roles walking up AXParent until (and including) the first AXWebArea.
pub fn ancestor_roles(element: AXUIElementRef) -> Vec<String> {
    let mut roles = Vec::new();
    let mut current: CFTypeRef = ptr::null();
    let mut cursor = element;
    for _ in 0..32 {
        let Ok(parent) = copy_attr(cursor, "AXParent") else {
            break;
        };
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
    roles
}
