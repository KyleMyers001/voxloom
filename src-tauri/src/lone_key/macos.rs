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
//! Between run-loop slices the tap thread reads what the checker thread
//! publishes (see `crate::tap_guard`): it re-enables a disabled tap only once
//! a check that started after the disable finds access granted, and within
//! budget; on loss it tears the tap down, fails closed and sends
//! `AccessLost`. Re-arming waits for the next save or launch.

use super::context::{active_context, Context, Tap, ACTIVE, LIVE};
use super::delivery::{Delivery, Sink};
use super::machine::Kind;
use super::tap_ffi::*;
use super::LoneKey;
use crate::tap_guard::{self, AccessWatch, TapGuard, Verdict};
use crate::tap_thread::{self, Ended, RunLoop, TapThread};
use std::{ptr, rc::Rc, sync::Mutex, time::Instant};

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
        // Fail closed (the machine already released any hold). Whether to
        // listen again needs a fresh permission check, which must not run in
        // a callback: end this run-loop slice so the watchdog asks for one.
        #[cfg(debug_assertions)]
        eprintln!("[lone-key] tap disabled (type {event_type:#x})");
        context.note_disabled(event_type == DISABLED_BY_TIMEOUT);
        tap_thread::wake_current();
    }
    event
}

/// Between run-loop slices: keep, re-enable or give up the tap. Returns
/// whether it stays. Reads what the checker published; never probes here.
fn watch(guard: &mut TapGuard, access: &AccessWatch) -> bool {
    ACTIVE.with(|slot| {
        let slot = slot.borrow();
        let Some(tap) = slot.as_ref() else {
            return false;
        };
        let disabled = tap.context.take_disabled();
        match guard.check(disabled, access.snapshot(), Instant::now()) {
            Verdict::Keep => true,
            Verdict::AwaitCheck => {
                access.nudge();
                true
            }
            Verdict::Reenable => {
                // SAFETY: the tap thread, outside the callback; a live port.
                unsafe { CGEventTapEnable(tap.port, true) };
                true
            }
            Verdict::TearDown => false,
        }
    })
}

fn on_main_thread() -> Result<(), String> {
    // SAFETY: pointer-free run-loop identity queries.
    if unsafe { CFRunLoopGetMain() == CFRunLoopGetCurrent() } {
        Ok(())
    } else {
        Err("lone-key listener must run on the main thread".into())
    }
}

/// Start listening for `key`, replacing any earlier listener.
pub fn arm(key: LoneKey, sink: Sink) -> Result<(), String> {
    on_main_thread()?;
    disarm()?;
    if !super::access::accessibility_trusted() {
        return Err(
            "Accessibility permission is needed to use a single key as the shortcut".into(),
        );
    }
    let generation = LIVE.advance();
    let thread = tap_thread::spawn("lone-key-tap", move |ready, stopping| {
        let installed = Delivery::spawn(LIVE.clone(), generation, sink)
            .and_then(|delivery| install(Rc::new(Context::new(generation, key, delivery))));
        // The tap was just created, which proves access; without its
        // watch it could outlive Accessibility, so it is not kept.
        let access = installed.and_then(|()| {
            tap_guard::watch_access().inspect_err(|_| {
                uninstall();
            })
        });
        let access = match access {
            Ok(access) => access,
            Err(e) => {
                ready.report(Err(e));
                return;
            }
        };
        if !ready.report(Ok(RunLoop::current())) {
            uninstall();
            return;
        }
        let mut guard = TapGuard::default();
        let ended = tap_thread::run_until_stopped(&stopping, || watch(&mut guard, &access));
        drop(access);
        let context = uninstall();
        if let (Ended::Lost, Some(context)) = (ended, context) {
            context.lose();
        }
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
/// callback can be running. Returns its context for a last word.
fn uninstall() -> Option<Rc<Context>> {
    let tap = ACTIVE.with(|slot| slot.borrow_mut().take())?;
    // SAFETY: the tap thread, outside the callback. Stop callbacks before the
    // context drops; each create-rule object is released exactly once.
    unsafe {
        CGEventTapEnable(tap.port, false);
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), tap.source, kCFRunLoopCommonModes);
        CFMachPortInvalidate(tap.port);
        CFRelease(tap.source);
        CFRelease(tap.port);
    }
    Some(tap.context)
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
