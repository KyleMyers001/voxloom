//! Hand-declared CoreGraphics / CoreFoundation bindings for the Escape tap.

use std::ffi::c_void;

pub(super) type Handle = *mut c_void;
pub(super) type Callback = unsafe extern "C" fn(Handle, u32, Handle, Handle) -> Handle;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // Apple AXUIElement.h: Boolean (UInt8), available since macOS 10.4.
    // No options/prompting; queries this app process, not an external helper.
    pub(super) fn AXIsProcessTrusted() -> u8;
    pub(super) fn CGEventTapCreate(
        location: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: Callback,
        context: Handle,
    ) -> Handle;
    pub(super) fn CGEventGetIntegerValueField(event: Handle, field: u32) -> i64;
    pub(super) fn CGEventTapEnable(tap: Handle, enable: bool);
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    // Apple CGEvent.h: bool; macOS 10.15 (the app's minimum). Preflight only:
    // never call the corresponding CGRequest* APIs or change TCC state here.
    pub(super) fn CGPreflightListenEventAccess() -> bool;
    pub(super) fn CGPreflightPostEventAccess() -> bool;
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
    pub(super) fn CFRunLoopAddSource(loop_: Handle, source: Handle, mode: *const c_void);
    pub(super) fn CFRunLoopRemoveSource(loop_: Handle, source: Handle, mode: *const c_void);
    pub(super) fn CFRelease(value: *const c_void);
    pub(super) static kCFRunLoopCommonModes: *const c_void;
}
