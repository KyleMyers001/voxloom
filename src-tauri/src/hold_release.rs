//! macOS hold-release escalation (BUS-13 / BUS-12 ADR).
//!
//! Carbon `RegisterEventHotKey` installs `kEventHotKeyReleased`, but macOS
//! often never delivers Released when modifiers lift before the key. While a
//! hold is active we install a listen-only CGEvent tap for key-up and
//! flagsChanged on the bound chord; if the tap cannot be created we fall back
//! to a short CGEvent session-state poll. Either path emits
//! `shortcut:hold-release` once so the TS gesture machine can finish.
//!
//! Tear-down on disarm / cancel / error / latch paths. Does **not** grab Escape.
//! Non-macOS builds expose no-op commands so Linux `cargo check` stays green.
//!
//! ## Poll / tap signal rules (Mac false-fire)
//!
//! Under `RegisterEventHotKey`, `CGEventSourceKeyState` for the letter key can
//! read **false** while the key is still physically held. Treat **required
//! modifiers still down ⇒ chord held** as the primary poll signal. A short
//! poll debounce (consecutive broken ticks) is only a backup against flaky
//! flag reads — never a substitute when mods are still down. Tap
//! `flagsChanged` does not emit immediately (poll confirms). Letter key-up
//! from the event tap still finishes (key-first); do not trust KeyState poll
//! for the letter alone.

use tauri::AppHandle;

/// Consecutive poll ticks that must look broken before emitting release.
/// Backup only — modifiers-still-down always wins as "held".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const BROKEN_POLL_DEBOUNCE_TICKS: u32 = 2;

/// Pure hold decision from one session-state sample (testable on all platforms).
///
/// When the chord requires modifiers, **mods_match** is authoritative: letter
/// `KeyState` may lie under Carbon HotKey. Debounce is applied by the caller
/// across ticks, not here.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn chord_held_from_sample(requires_modifiers: bool, key_down: bool, mods_match: bool) -> bool {
    if requires_modifiers {
        // PRIMARY: required modifiers still down ⇒ still held (even if !key_down).
        return mods_match;
    }
    key_down
}

/// Update broken-tick streak; returns `(new_streak, should_emit_release)`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn note_broken_poll_tick(streak: u32, held: bool) -> (u32, bool) {
    if held {
        return (0, false);
    }
    let next = streak.saturating_add(1);
    (next, next >= BROKEN_POLL_DEBOUNCE_TICKS)
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};

    use super::{chord_held_from_sample, note_broken_poll_tick};

    pub const HOLD_RELEASE_EVENT: &str = "shortcut:hold-release";

    /// kCGEventSourceStateCombinedSessionState
    const SESSION_STATE: u32 = 0;

    const FLAG_SHIFT: u64 = 1 << 17;
    const FLAG_CONTROL: u64 = 1 << 18;
    const FLAG_OPTION: u64 = 1 << 19;
    const FLAG_COMMAND: u64 = 1 << 20;

    // CGEventType
    const EVENT_KEY_UP: u32 = 11;
    const EVENT_FLAGS_CHANGED: u32 = 12;

    // CGEventField
    const FIELD_KEYBOARD_EVENT_KEYCODE: u32 = 9;

    // CGEventTapLocation / Placement / Options
    const TAP_SESSION: u32 = 1; // kCGSessionEventTap
    const TAP_HEAD: u32 = 0; // kCGHeadInsertEventTap
    const TAP_LISTEN_ONLY: u32 = 1; // kCGEventTapOptionListenOnly

    const MASK_KEY_UP: u64 = 1u64 << EVENT_KEY_UP;
    const MASK_FLAGS_CHANGED: u64 = 1u64 << EVENT_FLAGS_CHANGED;

    type CFMachPortRef = *mut c_void;
    type CFRunLoopSourceRef = *mut c_void;
    type CFRunLoopRef = *mut c_void;
    type CGEventRef = *mut c_void;
    type CGEventTapProxy = *mut c_void;

    type CGEventTapCallBack = unsafe extern "C" fn(
        proxy: CGEventTapProxy,
        etype: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state_id: u32, key_code: u16) -> bool;
        fn CGEventSourceFlagsState(state_id: u32) -> u64;
        fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        fn CGEventGetFlags(event: CGEventRef) -> u64;
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;
        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(
            allocator: *mut c_void,
            port: CFMachPortRef,
            order: isize,
        ) -> CFRunLoopSourceRef;
        fn CFMachPortInvalidate(port: CFMachPortRef);
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
        fn CFRunLoopRemoveSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
        fn CFRunLoopGetMain() -> CFRunLoopRef;
        fn CFRelease(cf: *mut c_void);
        static kCFRunLoopCommonModes: *const c_void;
    }

    #[derive(Clone, Copy, Debug)]
    struct Chord {
        key_code: u16,
        need_control: bool,
        need_shift: bool,
        need_option: bool,
        need_command: bool,
    }

    impl Chord {
        fn requires_modifiers(self) -> bool {
            self.need_control || self.need_shift || self.need_option || self.need_command
        }

        fn still_held(self) -> bool {
            // SAFETY: CoreGraphics session-state queries; no pointers.
            let key_down = unsafe { CGEventSourceKeyState(SESSION_STATE, self.key_code) };
            let flags = unsafe { CGEventSourceFlagsState(SESSION_STATE) };
            let mods_match = self.flags_match(flags);
            chord_held_from_sample(self.requires_modifiers(), key_down, mods_match)
        }

        fn flags_match(self, flags: u64) -> bool {
            if self.need_control && (flags & FLAG_CONTROL) == 0 {
                return false;
            }
            if self.need_shift && (flags & FLAG_SHIFT) == 0 {
                return false;
            }
            if self.need_option && (flags & FLAG_OPTION) == 0 {
                return false;
            }
            if self.need_command && (flags & FLAG_COMMAND) == 0 {
                return false;
            }
            true
        }

        /// Tap events that may finish the hold immediately.
        ///
        /// Letter key-up still finishes (key-first release). `flagsChanged` does
        /// **not** emit here — it can false-trigger; the session-state poll
        /// (mods-primary + debounce) confirms modifier breaks.
        fn tap_emits_release(self, etype: u32, event: CGEventRef) -> bool {
            if etype == EVENT_KEY_UP {
                // SAFETY: event is a live CGEvent from the tap callback.
                let code =
                    unsafe { CGEventGetIntegerValueField(event, FIELD_KEYBOARD_EVENT_KEYCODE) };
                return code as u16 == self.key_code;
            }
            // EVENT_FLAGS_CHANGED: never immediate emit (debounce via poll).
            let _ = event;
            false
        }
    }

    struct TapCtx {
        app: AppHandle,
        chord: Chord,
        generation: u64,
    }

    struct Armed {
        poll_stop: Arc<AtomicBool>,
        tap: Option<CFMachPortRef>,
        source: Option<CFRunLoopSourceRef>,
        /// Leaked only while armed; freed on disarm.
        ctx: Option<*mut TapCtx>,
    }

    // SAFETY: CFMachPort / run-loop source are only touched from the main
    // thread on arm/disarm; the tap callback only reads TapCtx immutably.
    unsafe impl Send for Armed {}

    static ARMED: Mutex<Option<Armed>> = Mutex::new(None);
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    static EMITTED: AtomicBool = AtomicBool::new(false);

    fn parse_plugin_hotkey(hotkey: &str) -> Result<Chord, String> {
        let parts: Vec<&str> = hotkey
            .split('+')
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .collect();
        if parts.is_empty() {
            return Err("empty hotkey".into());
        }
        let key = parts[parts.len() - 1];
        let mods = &parts[..parts.len() - 1];
        let mut chord = Chord {
            key_code: key_to_code(key)?,
            need_control: false,
            need_shift: false,
            need_option: false,
            need_command: false,
        };
        for m in mods {
            match m.to_ascii_lowercase().as_str() {
                "control" | "ctrl" => chord.need_control = true,
                "shift" => chord.need_shift = true,
                "alt" | "option" => chord.need_option = true,
                "command" | "cmd" | "meta" | "super" => chord.need_command = true,
                other => return Err(format!("unknown modifier {other}")),
            }
        }
        Ok(chord)
    }

    fn key_to_code(key: &str) -> Result<u16, String> {
        let lower = key.to_ascii_lowercase();
        Ok(match lower.as_str() {
            "space" => 49,
            "return" | "enter" => 36,
            "tab" => 48,
            "delete" | "backspace" => 51,
            "escape" | "esc" => 53,
            "left" => 123,
            "right" => 124,
            "down" => 125,
            "up" => 126,
            "a" => 0,
            "s" => 1,
            "d" => 2,
            "f" => 3,
            "h" => 4,
            "g" => 5,
            "z" => 6,
            "x" => 7,
            "c" => 8,
            "v" => 9,
            "b" => 11,
            "q" => 12,
            "w" => 13,
            "e" => 14,
            "r" => 15,
            "y" => 16,
            "t" => 17,
            "1" => 18,
            "2" => 19,
            "3" => 20,
            "4" => 21,
            "6" => 22,
            "5" => 23,
            "9" => 25,
            "7" => 26,
            "8" => 28,
            "0" => 29,
            "o" => 31,
            "u" => 32,
            "i" => 34,
            "p" => 35,
            "l" => 37,
            "j" => 38,
            "k" => 40,
            "n" => 45,
            "m" => 46,
            other => {
                return Err(format!("unsupported key '{other}' for hold-release watch"));
            }
        })
    }

    fn diag_emit_source(source: &str) {
        // Dev/diag only — no PII (hotkey/chord not logged).
        #[cfg(debug_assertions)]
        eprintln!("[hold-release] emit source={source}");
        let _ = source;
    }

    fn emit_release(app: &AppHandle, generation: u64, source: &str) {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if EMITTED.swap(true, Ordering::SeqCst) {
            return;
        }
        diag_emit_source(source);
        let _ = app.emit(HOLD_RELEASE_EVENT, ());
        let _ = disarm_inner();
    }

    unsafe extern "C" fn tap_callback(
        _proxy: CGEventTapProxy,
        etype: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef {
        if user_info.is_null() {
            return event;
        }
        let ctx = &*(user_info as *const TapCtx);
        // flagsChanged: do not emit here (poll debounce). Letter key-up: emit
        // for key-first release (event tap is trustworthy; KeyState poll is not).
        if ctx.chord.tap_emits_release(etype, event) {
            emit_release(&ctx.app, ctx.generation, "tap");
        }
        event
    }

    fn try_install_tap(
        app: AppHandle,
        chord: Chord,
        generation: u64,
    ) -> Option<(CFMachPortRef, CFRunLoopSourceRef, *mut TapCtx)> {
        let ctx = Box::into_raw(Box::new(TapCtx {
            app,
            chord,
            generation,
        }));
        // SAFETY: FFI to CoreGraphics / CoreFoundation for a listen-only tap.
        unsafe {
            let tap = CGEventTapCreate(
                TAP_SESSION,
                TAP_HEAD,
                TAP_LISTEN_ONLY,
                MASK_KEY_UP | MASK_FLAGS_CHANGED,
                tap_callback,
                ctx as *mut c_void,
            );
            if tap.is_null() {
                drop(Box::from_raw(ctx));
                return None;
            }
            let source = CFMachPortCreateRunLoopSource(std::ptr::null_mut(), tap, 0);
            if source.is_null() {
                CFMachPortInvalidate(tap);
                CFRelease(tap);
                drop(Box::from_raw(ctx));
                return None;
            }
            CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(tap, true);
            Some((tap, source, ctx))
        }
    }

    fn start_poll_fallback(app: AppHandle, chord: Chord, generation: u64) -> Arc<AtomicBool> {
        let poll_stop = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&poll_stop);
        thread::Builder::new()
            .name("voxloom-hold-release".into())
            .spawn(move || {
                // Brief settle so the Pressed-edge session state is stable.
                thread::sleep(Duration::from_millis(20));
                let mut broken_streak = 0u32;
                while !stop_flag.load(Ordering::SeqCst) {
                    if GENERATION.load(Ordering::SeqCst) != generation {
                        break;
                    }
                    let held = chord.still_held();
                    let (next, should_emit) = note_broken_poll_tick(broken_streak, held);
                    broken_streak = next;
                    if should_emit {
                        emit_release(&app, generation, "poll");
                        break;
                    }
                    thread::sleep(Duration::from_millis(16));
                }
            })
            .ok();
        poll_stop
    }

    fn start_watch(app: AppHandle, chord: Chord, generation: u64) -> Armed {
        if let Some((tap, source, ctx)) = try_install_tap(app.clone(), chord, generation) {
            // Poll owns mods-first finish (mods-primary + debounce). Tap owns
            // letter key-up (key-first); flagsChanged does not emit from tap.
            let poll_stop = start_poll_fallback(app, chord, generation);
            Armed {
                poll_stop,
                tap: Some(tap),
                source: Some(source),
                ctx: Some(ctx),
            }
        } else {
            // No Accessibility / tap denied — session-state poll still works.
            let poll_stop = start_poll_fallback(app, chord, generation);
            Armed {
                poll_stop,
                tap: None,
                source: None,
                ctx: None,
            }
        }
    }

    fn disarm_inner() -> Result<(), String> {
        let mut guard = ARMED.lock().map_err(|e| e.to_string())?;
        if let Some(armed) = guard.take() {
            armed.poll_stop.store(true, Ordering::SeqCst);
            GENERATION.fetch_add(1, Ordering::SeqCst);
            // SAFETY: tear down tap/source/ctx we installed on arm.
            unsafe {
                if let (Some(tap), Some(source)) = (armed.tap, armed.source) {
                    CGEventTapEnable(tap, false);
                    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
                    CFMachPortInvalidate(tap);
                    CFRelease(source);
                    CFRelease(tap);
                }
                if let Some(ctx) = armed.ctx {
                    drop(Box::from_raw(ctx));
                }
            }
        }
        Ok(())
    }

    /// Returns `true` when a real hold-release monitor is active (tap and/or
    /// session-state poll). Callers on Mac should treat this as owning finish
    /// and ignore spurious Carbon `HotKey Released` (e.g. on focus loss).
    pub fn arm(app: AppHandle, plugin_hotkey: String) -> Result<bool, String> {
        let chord = parse_plugin_hotkey(&plugin_hotkey)?;
        let _ = disarm_inner();
        EMITTED.store(false, Ordering::SeqCst);
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let armed = start_watch(app, chord, generation);
        let mut guard = ARMED.lock().map_err(|e| e.to_string())?;
        *guard = Some(armed);
        Ok(true)
    }

    pub fn disarm() -> Result<(), String> {
        EMITTED.store(true, Ordering::SeqCst);
        disarm_inner()
    }
}

#[cfg(not(target_os = "macos"))]
mod stub {
    use tauri::AppHandle;

    pub fn arm(_app: AppHandle, _plugin_hotkey: String) -> Result<bool, String> {
        // No monitor on non-macOS — OS Pressed/Released remain authoritative.
        Ok(false)
    }

    pub fn disarm() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
use macos::{arm as arm_impl, disarm as disarm_impl};

#[cfg(not(target_os = "macos"))]
use stub::{arm as arm_impl, disarm as disarm_impl};

/// Arm Mac hold-release watch for the plugin-format hotkey
/// (e.g. `Control+Shift+F`).
#[tauri::command]
pub fn hold_release_arm(app: AppHandle, hotkey: String) -> Result<bool, String> {
    arm_impl(app, hotkey)
}

/// Tear down any active hold-release watch.
#[tauri::command]
pub fn hold_release_disarm() -> Result<(), String> {
    disarm_impl()
}

#[cfg(test)]
mod tests {
    use super::{chord_held_from_sample, note_broken_poll_tick, BROKEN_POLL_DEBOUNCE_TICKS};

    #[test]
    fn mods_still_down_means_held_even_when_letter_keystate_false() {
        assert!(chord_held_from_sample(true, false, true));
        assert!(chord_held_from_sample(true, true, true));
    }

    #[test]
    fn mods_broken_means_not_held_for_modifier_chord() {
        assert!(!chord_held_from_sample(true, true, false));
        assert!(!chord_held_from_sample(true, false, false));
    }

    #[test]
    fn bare_key_uses_letter_keystate() {
        assert!(chord_held_from_sample(false, true, true));
        assert!(chord_held_from_sample(false, true, false));
        assert!(!chord_held_from_sample(false, false, true));
        assert!(!chord_held_from_sample(false, false, false));
    }

    #[test]
    fn debounce_requires_n_consecutive_broken_polls() {
        assert_eq!(BROKEN_POLL_DEBOUNCE_TICKS, 2);
        let (s1, emit1) = note_broken_poll_tick(0, false);
        assert_eq!(s1, 1);
        assert!(!emit1);
        let (s2, emit2) = note_broken_poll_tick(s1, false);
        assert_eq!(s2, 2);
        assert!(emit2);
    }

    #[test]
    fn held_sample_resets_broken_streak() {
        let (s, emit) = note_broken_poll_tick(1, true);
        assert_eq!(s, 0);
        assert!(!emit);
    }

    #[test]
    fn single_broken_tick_does_not_emit() {
        // Backup debounce must not fire on one flaky flags read.
        let (s, emit) = note_broken_poll_tick(0, false);
        assert_eq!(s, 1);
        assert!(!emit);
    }
}
