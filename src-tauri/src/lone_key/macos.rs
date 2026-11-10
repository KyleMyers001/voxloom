//! macOS glue: an active (default-option) CGEventTap that feeds
//! `LoneKeyMachine`. An active tap needs Accessibility, which insertion and
//! Esc-to-cancel already need; a listen-only tap would need Input Monitoring
//! (BUS-209). The callback passes every event through unchanged. `arm` never
//! prompts: it preflights and reports (same stance as `cancel_scope::macos`).
//! The one prompt is `request_access`, which the webview calls when the user
//! saves a lone key, never at launch.
//! `arm` / `disarm` run on the main thread; the tap itself lives on its own
//! thread and run loop (`crate::tap_thread`), which creates it, owns its
//! state (`ACTIVE`, the debounce timer) and tears it down, so a main-thread
//! stall never delays other apps' input. The callback never calls the sink:
//! edges go to a delivery thread (see `delivery`), so nothing the app does
//! with an edge can re-enter or free the tap.

use super::context::{active_context, Context, Tap, ACTIVE, LIVE};
use super::delivery::{Delivery, Sink};
use super::machine::Kind;
use super::tap_ffi::*;
use super::LoneKey;
use crate::tap_thread::{self, RunLoop, TapThread};
use std::{ptr, rc::Rc, sync::Mutex};

/// The running tap thread, if armed. Only `arm` / `disarm` touch it.
static THREAD: Mutex<Option<TapThread<RunLoop>>> = Mutex::new(None);

fn event_kind(event_type: u32) -> Option<Kind> {
    match event_type {
        KEY_DOWN => Some(Kind::KeyDown),
        KEY_UP => Some(Kind::KeyUp),
        FLAGS_CHANGED => Some(Kind::FlagsChanged),
        LEFT_MOUSE_DOWN | RIGHT_MOUSE_DOWN | OTHER_MOUSE_DOWN => Some(Kind::MouseDown),
        DISABLED_BY_TIMEOUT | DISABLED_BY_USER_INPUT => Some(Kind::TapDisabled),
        _ => None,
    }
}

unsafe extern "C" fn callback(_: Handle, event_type: u32, event: Handle, info: Handle) -> Handle {
    // `info` is the generation, not a pointer: nothing here is dereferenced
    // unless it is the armed context. The Rc keeps it alive for this call.
    let Some(context) = active_context(info as usize as u64) else {
        return event;
    };
    let Some(mut kind) = event_kind(event_type) else {
        return event;
    };
    let disabled = kind == Kind::TapDisabled;
    let (keycode, flags) = if disabled || event.is_null() {
        (0, 0)
    } else {
        if kind == Kind::KeyDown && CGEventGetIntegerValueField(event, AUTOREPEAT_FIELD) != 0 {
            kind = Kind::KeyRepeat;
        }
        (
            CGEventGetIntegerValueField(event, KEYCODE_FIELD) as u16,
            CGEventGetFlags(event),
        )
    };
    context.step(kind, keycode, flags);
    if disabled {
        // Fail closed (the machine already released any hold), then listen
        // again: the tap returns every event unchanged, so re-enabling is
        // safe.
        #[cfg(debug_assertions)]
        eprintln!("[lone-key] tap disabled (type {event_type:#x}); re-enabling");
        ACTIVE.with(|slot| {
            if let Some(tap) = slot
                .borrow()
                .as_ref()
                .filter(|tap| Rc::ptr_eq(&tap.context, &context))
            {
                CGEventTapEnable(tap.port, true);
            }
        });
    }
    event
}

fn on_main_thread() -> Result<(), String> {
    // SAFETY: pointer-free run-loop identity queries.
    if unsafe { CFRunLoopGetMain() == CFRunLoopGetCurrent() } {
        Ok(())
    } else {
        Err("lone-key listener must run on the main thread".into())
    }
}

fn accessibility_trusted() -> bool {
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

/// Start listening for `key`, replacing any earlier listener.
pub fn arm(key: LoneKey, sink: Sink) -> Result<(), String> {
    on_main_thread()?;
    disarm()?;
    if !accessibility_trusted() {
        return Err(
            "Accessibility permission is needed to use a single key as the shortcut".into(),
        );
    }
    let generation = LIVE.advance();
    let thread = tap_thread::spawn("lone-key-tap", move |ready, stopping| {
        let installed = Delivery::spawn(LIVE.clone(), generation, sink)
            .and_then(|delivery| install(Rc::new(Context::new(generation, key, delivery))));
        if let Err(e) = installed {
            ready.report(Err(e));
            return;
        }
        if ready.report(Ok(RunLoop::current())) {
            tap_thread::run_until_stopped(&stopping);
        }
        uninstall();
    })?;
    *THREAD.lock().map_err(|e| e.to_string())? = Some(thread);
    Ok(())
}

/// Create the tap on this (tap) thread's run loop and park its state in
/// `ACTIVE`.
fn install(context: Rc<Context>) -> Result<(), String> {
    let mask = [
        LEFT_MOUSE_DOWN,
        RIGHT_MOUSE_DOWN,
        OTHER_MOUSE_DOWN,
        KEY_DOWN,
        KEY_UP,
        FLAGS_CHANGED,
    ]
    .iter()
    .fold(0u64, |mask, kind| mask | (1 << kind));
    // SAFETY: active session tap whose callback returns every event as is;
    // the context is only reached through `ACTIVE` by generation, so the
    // callback holds no pointer to it.
    unsafe {
        let port = CGEventTapCreate(
            TAP_SESSION,
            TAP_HEAD,
            TAP_DEFAULT,
            mask,
            callback,
            context.generation as usize as Handle,
        );
        if port.is_null() {
            return Err("Could not listen for the shortcut key (Accessibility may be off)".into());
        }
        let source = CFMachPortCreateRunLoopSource(ptr::null_mut(), port, 0);
        if source.is_null() {
            CFMachPortInvalidate(port);
            CFRelease(port);
            return Err("Could not create the shortcut key monitor".into());
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(port, true);
        ACTIVE.with(|slot| {
            *slot.borrow_mut() = Some(Tap {
                port,
                source,
                context,
            })
        });
    }
    Ok(())
}

/// Tear the tap down on its own thread, after its run loop stopped, so no
/// callback can be running.
fn uninstall() {
    let Some(tap) = ACTIVE.with(|slot| slot.borrow_mut().take()) else {
        return;
    };
    // SAFETY: the tap thread, outside the callback. Stop callbacks before the
    // context drops; each create-rule object is released exactly once.
    unsafe {
        CGEventTapEnable(tap.port, false);
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), tap.source, kCFRunLoopCommonModes);
        CFMachPortInvalidate(tap.port);
        CFRelease(tap.source);
        CFRelease(tap.port);
    }
}

/// Stop listening. Any hold in progress is dropped without an edge, so the
/// caller finishes it (its existing teardown). Edges already queued for the
/// old listener are dropped, not delivered late. Returns once the tap
/// thread has torn the tap down.
pub fn disarm() -> Result<(), String> {
    on_main_thread()?;
    LIVE.advance();
    let thread = THREAD.lock().map_err(|e| e.to_string())?.take();
    if let Some(thread) = thread {
        thread.stop(RunLoop::stop);
    }
    Ok(())
}
