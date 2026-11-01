//! Hand-declared CoreGraphics / CoreFoundation bindings for the lone-key tap
//! (same style as `hold_release.rs`).

use std::ffi::c_void;

pub(super) type Handle = *mut c_void;
pub(super) type Callback = unsafe extern "C" fn(Handle, u32, Handle, Handle) -> Handle;

// CGEventType
pub(super) const LEFT_MOUSE_DOWN: u32 = 1;
pub(super) const RIGHT_MOUSE_DOWN: u32 = 3;
pub(super) const KEY_DOWN: u32 = 10;
pub(super) const KEY_UP: u32 = 11;
pub(super) const FLAGS_CHANGED: u32 = 12;
pub(super) const OTHER_MOUSE_DOWN: u32 = 25;
pub(super) const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
pub(super) const DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
pub(super) const KEYCODE_FIELD: u32 = 9; // kCGKeyboardEventKeycode
pub(super) const AUTOREPEAT_FIELD: u32 = 8; // kCGKeyboardEventAutorepeat
pub(super) const TAP_SESSION: u32 = 1;
pub(super) const TAP_HEAD: u32 = 0;
pub(super) const TAP_LISTEN_ONLY: u32 = 1;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub(super) fn CGEventTapCreate(
        location: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: Callback,
        context: Handle,
    ) -> Handle;
    pub(super) fn CGEventTapEnable(tap: Handle, enable: bool);
    pub(super) fn CGEventGetIntegerValueField(event: Handle, field: u32) -> i64;
    pub(super) fn CGEventGetFlags(event: Handle) -> u64;
    // Preflight only: never call CGRequestListenEventAccess here.
    pub(super) fn CGPreflightListenEventAccess() -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub(super) fn CFMachPortCreateRunLoopSource(
        allocator: Handle,
        tap: Handle,
        order: isize,
    ) -> Handle;
    pub(super) fn CFMachPortInvalidate(tap: Handle);
    pub(super) fn CFRunLoopGetMain() -> Handle;
    pub(super) fn CFRunLoopGetCurrent() -> Handle;
    pub(super) fn CFRunLoopAddSource(run_loop: Handle, source: Handle, mode: *const c_void);
    pub(super) fn CFRunLoopRemoveSource(run_loop: Handle, source: Handle, mode: *const c_void);
    pub(super) fn CFRelease(value: *const c_void);
    pub(super) static kCFRunLoopCommonModes: *const c_void;
}
