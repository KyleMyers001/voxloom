//! Unicode key-event typing (ADR §6): no clipboard, no layout-dependent
//! keycodes, no modifier flags. Web fallback verifies read-back; the separate
//! Apple Terminal path only reports events posted, never input confirmation.

use super::ax::{release, CFTypeRef};
use crate::delivery::decide::{utf16_chunks, KEY_EVENT_UTF16_MAX};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state_id: i32) -> CFTypeRef;
    fn CGPreflightPostEventAccess() -> bool;
    fn CGEventCreateKeyboardEvent(source: CFTypeRef, keycode: u16, keydown: bool) -> CFTypeRef;
    fn CGEventKeyboardSetUnicodeString(event: CFTypeRef, len: usize, chars: *const u16);
    fn CGEventSetFlags(event: CFTypeRef, flags: u64);
    fn CGEventPost(tap: u32, event: CFTypeRef);
}

const HID_EVENT_TAP: u32 = 0;
/// kCGEventSourceStatePrivate: not affected by physically held modifiers.
const SOURCE_PRIVATE_STATE: i32 = -1;

// Only the OS calls are injectable: tests exercise the same allocation,
// ordering, focus/read-back and ownership logic without posting GUI input.
trait Events {
    fn source(&self, state: i32) -> CFTypeRef;
    fn post_access(&self) -> bool;
    fn keyboard(&self, source: CFTypeRef, keycode: u16, down: bool) -> CFTypeRef;
    fn unicode(&self, event: CFTypeRef, units: &[u16]);
    fn flags(&self, event: CFTypeRef, flags: u64);
    fn post(&self, tap: u32, event: CFTypeRef);
    fn release(&self, value: CFTypeRef);
}

struct NativeEvents;
impl Events for NativeEvents {
    fn post_access(&self) -> bool {
        unsafe { CGPreflightPostEventAccess() }
    }
    fn source(&self, state: i32) -> CFTypeRef {
        unsafe { CGEventSourceCreate(state) }
    }
    fn keyboard(&self, source: CFTypeRef, keycode: u16, down: bool) -> CFTypeRef {
        unsafe { CGEventCreateKeyboardEvent(source, keycode, down) }
    }
    fn unicode(&self, event: CFTypeRef, units: &[u16]) {
        unsafe { CGEventKeyboardSetUnicodeString(event, units.len(), units.as_ptr()) }
    }
    fn flags(&self, event: CFTypeRef, flags: u64) {
        unsafe { CGEventSetFlags(event, flags) }
    }
    fn post(&self, tap: u32, event: CFTypeRef) {
        unsafe { CGEventPost(tap, event) }
    }
    fn release(&self, value: CFTypeRef) {
        release(value);
    }
}

struct OwnedEvent<'a, E: Events>(&'a E, CFTypeRef);
impl<E: Events> Drop for OwnedEvent<'_, E> {
    fn drop(&mut self) {
        if !self.1.is_null() {
            self.0.release(self.1);
        }
    }
}

fn post_chunk_with(api: &impl Events, source: CFTypeRef, units: &[u16]) -> Result<(), String> {
    let down = OwnedEvent(api, api.keyboard(source, 0, true));
    let up = OwnedEvent(api, api.keyboard(source, 0, false));
    if down.1.is_null() || up.1.is_null() {
        return Err("could not create key events".into());
    }
    api.unicode(down.1, units);
    api.flags(down.1, 0);
    api.flags(up.1, 0);
    api.post(HID_EVENT_TAP, down.1);
    api.post(HID_EVENT_TAP, up.1);
    Ok(())
}

/// Terminal has no trustworthy AX input-buffer oracle. Share exactly the
/// proven Unicode event transport, but report dispatch separately from proof.
/// The pure dispatcher preflights the ENTIRE payload before invoking `post`.
pub fn type_terminal(
    text: &str,
    still_target: impl Fn() -> Result<(), String>,
) -> Result<crate::delivery::decide::InsertReport, String> {
    type_terminal_with(&NativeEvents, text, still_target, || {
        // Pacing only, NOT a verifier. Never poll display/scrollback as proof.
        std::thread::sleep(std::time::Duration::from_millis(20));
    })
}

fn type_terminal_with(
    api: &impl Events,
    text: &str,
    still_target: impl Fn() -> Result<(), String>,
    mut pace: impl FnMut(),
) -> Result<crate::delivery::decide::InsertReport, String> {
    let source = OwnedEvent(api, api.source(SOURCE_PRIVATE_STATE));
    if source.1.is_null() {
        return Err("could not create private event source".into());
    }
    let result = crate::delivery::decide::terminal::dispatch(
        text,
        || {
            if !api.post_access() {
                return Err("Terminal event-posting permission denied".into());
            }
            still_target()
        },
        |chunk| {
            post_chunk_with(api, source.1, chunk)?;
            pace();
            Ok(())
        },
    );
    result
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
    type_text_with(&NativeEvents, text, still_target, confirm)
}

fn type_text_with(
    api: &impl Events,
    text: &str,
    still_target: impl Fn() -> Result<(), String>,
    confirm: impl Fn(&str) -> bool,
) -> (usize, Result<(), String>) {
    let source = OwnedEvent(api, api.source(SOURCE_PRIVATE_STATE));
    if source.1.is_null() {
        return (0, Err("could not create private event source".into()));
    }
    let mut posted = 0;
    let mut sent: Vec<u16> = Vec::new();
    let mut result = Ok(());
    for chunk in utf16_chunks(text, KEY_EVENT_UTF16_MAX) {
        if let Err(e) = still_target().and_then(|()| post_chunk_with(api, source.1, &chunk)) {
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
    (posted, result)
}

#[cfg(test)]
#[path = "typing_tests.rs"]
mod tests;
