//! Accessibility for the lone-key tap: the non-prompting preflight `arm`
//! uses, and the one prompt, on a user's save (see `macos`).

use super::tap_ffi::*;
use std::ptr;

pub(super) fn accessibility_trusted() -> bool {
    // SAFETY: preflight query only; never prompts or changes TCC state.
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Show the system Accessibility prompt. Returns whether access is granted
/// now (normally `false`: the user answers in System Settings later).
fn prompt_for_accessibility() -> bool {
    // SAFETY: a one-entry CF dictionary built from Apple's constant key and
    // kCFBooleanTrue, released exactly once after the call.
    unsafe {
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let options = CFDictionaryCreate(
            ptr::null_mut(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
            ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast(),
        );
        if options.is_null() {
            return false;
        }
        let trusted = AXIsProcessTrustedWithOptions(options) != 0;
        CFRelease(options);
        trusted
    }
}

/// Ask for Accessibility if it is not granted yet. Returns whether it is
/// granted *now*: the system prompt answers later, so a first request is
/// normally `false`. Runs off the main thread (the call may wait on the
/// system); it touches no tap state.
pub fn request_access() -> bool {
    super::commands::request_if_needed(accessibility_trusted, prompt_for_accessibility)
}
