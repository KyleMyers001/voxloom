//! macOS glue: a listen-only CGEventTap that feeds `LoneKeyMachine`.
//! Listen-only needs Input Monitoring, not Accessibility. It never prompts:
//! it preflights and reports (same stance as `cancel_scope::macos`).
//! Everything runs on the main run loop; there is no unsafe Send/Sync.

use super::machine::{Edge, Kind, LoneKeyMachine, DEBOUNCE_MS};
use super::tap_ffi::*;
use super::LoneKey;
use std::{
    cell::{Cell, RefCell},
    ptr,
    rc::Rc,
    time::Duration,
    time::Instant,
};
use tauri::AppHandle;

/// Receives each edge on the main thread; must not arm or disarm.
pub type Sink = Box<dyn Fn(Edge)>;

struct Context {
    app: AppHandle,
    machine: RefCell<LoneKeyMachine>,
    sink: Sink,
    started: Instant,
    /// A debounce wake-up is already queued.
    tick_queued: Cell<bool>,
}

struct Tap {
    port: Handle,
    source: Handle,
    context: Rc<Context>,
}

thread_local! {
    static ACTIVE: RefCell<Option<Tap>> = const { RefCell::new(None) };
}

impl Context {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn emit(&self, edges: Vec<Edge>) {
        for edge in edges {
            (self.sink)(edge);
        }
        // A press waits out the debounce even if no key event follows.
        let pending = self.machine.borrow().pending_since();
        if let (Some(since), false) = (pending, self.tick_queued.get()) {
            self.tick_queued.set(true);
            let wait = DEBOUNCE_MS.saturating_sub(self.now().saturating_sub(since));
            self.queue_tick(wait);
        }
    }

    /// No event arrives while a modifier is simply held, so wake the main
    /// thread after the debounce (a short-lived thread per press).
    fn queue_tick(&self, wait_ms: u64) {
        let app = self.app.clone();
        let id = self as *const Context as usize;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(wait_ms));
            let _ = app.run_on_main_thread(move || tick(id));
        });
    }
}

/// The armed context; with `id`, only if it is that one (a wake-up queued
/// before a re-arm must not touch the new listener).
fn active_context(id: Option<usize>) -> Option<Rc<Context>> {
    ACTIVE.with(|slot| {
        let slot = slot.borrow();
        let context = &slot.as_ref()?.context;
        (id.is_none() || id == Some(Rc::as_ptr(context) as usize)).then(|| context.clone())
    })
}

fn tick(id: usize) {
    let Some(context) = active_context(Some(id)) else {
        return;
    };
    context.tick_queued.set(false);
    let edges = context.machine.borrow_mut().tick(context.now());
    context.emit(edges);
}

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
    if info.is_null() {
        return event;
    }
    // Own an Rc so a sink that re-arms can't free the context under us.
    let Some(context) = active_context(Some(info as usize)) else {
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
    let edges = context
        .machine
        .borrow_mut()
        .step(kind, keycode, flags, context.now());
    context.emit(edges);
    if disabled {
        // Fail closed (the machine already released any hold), then listen
        // again: a timeout-disabled listen-only tap is safe to re-enable.
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

/// Start listening for `key`, replacing any earlier listener.
pub fn arm(app: AppHandle, key: LoneKey, sink: Sink) -> Result<(), String> {
    on_main_thread()?;
    disarm()?;
    // SAFETY: preflight query only; never prompts or changes TCC state.
    if !unsafe { CGPreflightListenEventAccess() } {
        return Err(
            "Input Monitoring permission is needed to use a single key as the shortcut".into(),
        );
    }
    let context = Rc::new(Context {
        app,
        machine: RefCell::new(LoneKeyMachine::new(key)),
        sink,
        started: Instant::now(),
        tick_queued: Cell::new(false),
    });
    let raw = Rc::as_ptr(&context);
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
    // SAFETY: listen-only session tap; `raw` outlives it (freed in disarm
    // after the source is removed and the port invalidated).
    unsafe {
        let port = CGEventTapCreate(
            TAP_SESSION,
            TAP_HEAD,
            TAP_LISTEN_ONLY,
            mask,
            callback,
            raw as Handle,
        );
        if port.is_null() {
            return Err(
                "Could not listen for the shortcut key (Input Monitoring may be off)".into(),
            );
        }
        let source = CFMachPortCreateRunLoopSource(ptr::null_mut(), port, 0);
        if source.is_null() {
            CFMachPortInvalidate(port);
            CFRelease(port);
            return Err("Could not create the shortcut key monitor".into());
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
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

/// Stop listening. Any hold in progress is dropped without an edge, so the
/// caller finishes it (slice 3 uses its existing teardown).
pub fn disarm() -> Result<(), String> {
    on_main_thread()?;
    let tap = ACTIVE.with(|slot| slot.borrow_mut().take());
    if let Some(tap) = tap {
        // SAFETY: main thread, outside the callback. Stop callbacks before the
        // context drops; each create-rule object is released exactly once.
        unsafe {
            CGEventTapEnable(tap.port, false);
            CFRunLoopRemoveSource(CFRunLoopGetMain(), tap.source, kCFRunLoopCommonModes);
            CFMachPortInvalidate(tap.port);
            CFRelease(tap.source);
            CFRelease(tap.port);
        }
    }
    Ok(())
}
