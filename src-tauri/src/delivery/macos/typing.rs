//! Unicode key-event typing (ADR §6): no clipboard, no layout-dependent
//! keycodes, no modifier flags. Used only for web fields that ignored
//! AXSelectedText with their value unchanged.

use super::ax::{release, CFTypeRef};
use crate::delivery::decide::{utf16_chunks, KEY_EVENT_UTF16_MAX};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state_id: i32) -> CFTypeRef;
    fn CGEventCreateKeyboardEvent(source: CFTypeRef, keycode: u16, keydown: bool) -> CFTypeRef;
    fn CGEventKeyboardSetUnicodeString(event: CFTypeRef, len: usize, chars: *const u16);
    fn CGEventSetFlags(event: CFTypeRef, flags: u64);
    fn CGEventPost(tap: u32, event: CFTypeRef);
}

const HID_EVENT_TAP: u32 = 0;
/// kCGEventSourceStatePrivate: not affected by physically held modifiers.
const SOURCE_PRIVATE_STATE: i32 = -1;

fn post_chunk(source: CFTypeRef, units: &[u16]) -> Result<(), String> {
    unsafe {
        let down = CGEventCreateKeyboardEvent(source, 0, true);
        let up = CGEventCreateKeyboardEvent(source, 0, false);
        if down.is_null() || up.is_null() {
            release(down);
            release(up);
            return Err("could not create key events".into());
        }
        CGEventKeyboardSetUnicodeString(down, units.len(), units.as_ptr());
        CGEventSetFlags(down, 0);
        CGEventSetFlags(up, 0);
        CGEventPost(HID_EVENT_TAP, down);
        CGEventPost(HID_EVENT_TAP, up);
        release(down);
        release(up);
    }
    Ok(())
}

/// Type `text`, re-checking focus before every chunk and confirming each
/// chunk via read-back (`confirm(typed_so_far)`) before sending the next.
/// If a host ignored the Unicode string and typed the carrier key instead,
/// we stop after that one event rather than corrupting the field per chunk.
/// CGEventPost targets whatever is focused, so a focus change between a check
/// and its post (a few ms) is a documented, unclosable window.
/// Returns how many chunks were posted (for honest partial reporting).
pub fn type_text(
    text: &str,
    still_target: impl Fn() -> Result<(), String>,
    confirm: impl Fn(&str) -> bool,
) -> (usize, Result<(), String>) {
    let source = unsafe { CGEventSourceCreate(SOURCE_PRIVATE_STATE) };
    let mut posted = 0;
    let mut sent: Vec<u16> = Vec::new();
    let mut result = Ok(());
    for chunk in utf16_chunks(text, KEY_EVENT_UTF16_MAX) {
        if let Err(e) = still_target().and_then(|()| post_chunk(source, &chunk)) {
            result = Err(e);
            break;
        }
        posted += 1;
        sent.extend_from_slice(&chunk);
        if !confirm(&String::from_utf16_lossy(&sent)) {
            result = Err("typed text not confirmed by read-back — stopped".into());
            break;
        }
    }
    release(source);
    (posted, result)
}
