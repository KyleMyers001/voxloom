//! The Accessibility probe (macOS). It makes synchronous window-server
//! calls, so only the checker thread (`monitor`) runs it: never a tap
//! callback, a tap thread or the main thread.

use std::ffi::c_void;
use std::ptr;

type Handle = *mut c_void;
type Callback = unsafe extern "C" fn(Handle, u32, Handle, Handle) -> Handle;

const TAP_SESSION: u32 = 1; // kCGSessionEventTap
const TAP_TAIL: u32 = 1; // kCGTailAppendEventTap
const TAP_DEFAULT: u32 = 0; // kCGEventTapOptionDefault (active)
const MASK_NULL: u64 = 1; // CGEventMaskBit(kCGEventNull)

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // Apple AXUIElement.h: Boolean (UInt8). Never prompts.
    fn AXIsProcessTrusted() -> u8;
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        location: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: Callback,
        context: Handle,
    ) -> Handle;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortInvalidate(port: Handle);
    fn CFRelease(value: *const c_void);
}

unsafe extern "C" fn pass(_: Handle, _: u32, event: Handle, _: Handle) -> Handle {
    event
}

/// Whether an active tap is still allowed. `AXIsProcessTrusted` alone
/// can stay true after the app's Accessibility row is deleted, so also
/// create a throwaway active tap the way ours are created (an active
/// tap is what Accessibility authorizes; a listen-only one would test
/// Input Monitoring instead). It matches only null events, is never
/// added to a run loop, and is invalidated at once, so it holds nothing.
pub(super) fn still_trusted() -> bool {
    // SAFETY: a preflight query, then a create-rule port released
    // exactly once; the probe has no context and is never run.
    unsafe {
        if AXIsProcessTrusted() == 0 {
            return false;
        }
        let probe = CGEventTapCreate(
            TAP_SESSION,
            TAP_TAIL,
            TAP_DEFAULT,
            MASK_NULL,
            pass,
            ptr::null_mut(),
        );
        if probe.is_null() {
            return false;
        }
        CFMachPortInvalidate(probe);
        CFRelease(probe);
        true
    }
}
