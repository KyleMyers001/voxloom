//! The current layout's keycode for V, via Text Input Sources. TIS must run
//! on the main thread (it asserts the main queue on recent macOS), so the
//! lookup hops there; the delivery command itself runs on a worker thread.

use std::ffi::c_void;

use dispatch2::DispatchQueue;

use crate::delivery::decide::paste_key::{keycode_for_v, KEYCODE_ANSI_V};

type CFTypeRef = *const c_void;

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> CFTypeRef;
    fn TISGetInputSourceProperty(source: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    static kTISPropertyUnicodeKeyLayoutData: CFTypeRef;
    fn LMGetKbdType() -> u8;
    #[allow(clippy::too_many_arguments)]
    fn UCKeyTranslate(
        layout: *const c_void,
        virtual_key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        options: u32,
        dead_key_state: *mut u32,
        max_len: usize,
        actual_len: *mut usize,
        out: *mut u16,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDataGetBytePtr(data: CFTypeRef) -> *const u8;
    fn CFRelease(cf: CFTypeRef);
}

extern "C" {
    fn pthread_main_np() -> i32;
}

const KEY_ACTION_DOWN: u16 = 0;
/// cmdKey (0x0100) >> 8, as UCKeyTranslate expects.
const MODIFIER_COMMAND: u32 = 1;
const NO_DEAD_KEYS: u32 = 1;

/// Keycode that produces ⌘V in the current layout; ANSI V when unreadable.
pub fn v_keycode() -> u16 {
    // SAFETY: plain libSystem call.
    if unsafe { pthread_main_np() } != 0 {
        return lookup();
    }
    let mut key = KEYCODE_ANSI_V;
    DispatchQueue::main().exec_sync(|| key = lookup());
    key
}

fn lookup() -> u16 {
    // SAFETY: the layout data is owned by `source`, which outlives its use.
    unsafe {
        let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
        if source.is_null() {
            return KEYCODE_ANSI_V;
        }
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
        let key = if data.is_null() {
            KEYCODE_ANSI_V
        } else {
            let layout = CFDataGetBytePtr(data).cast::<c_void>();
            let keyboard = u32::from(LMGetKbdType());
            keycode_for_v(|code| translate(layout, code, keyboard))
        };
        CFRelease(source);
        key
    }
}

unsafe fn translate(layout: *const c_void, code: u16, keyboard: u32) -> Option<String> {
    let mut dead = 0u32;
    let mut out = [0u16; 4];
    let mut len = 0usize;
    let status = UCKeyTranslate(
        layout,
        code,
        KEY_ACTION_DOWN,
        MODIFIER_COMMAND,
        keyboard,
        NO_DEAD_KEYS,
        &mut dead,
        out.len(),
        &mut len,
        out.as_mut_ptr(),
    );
    (status == 0 && len > 0).then(|| String::from_utf16_lossy(&out[..len.min(out.len())]))
}
