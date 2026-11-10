use super::ffi::*;
use super::watch::Watch;
use super::{Action, ScopeState};
use std::{cell::RefCell, ptr, rc::Rc};
use tauri::{AppHandle, Emitter, Manager};

const OVERLAY: &str = "dictation-overlay";

struct Context {
    app: AppHandle,
    state: Rc<RefCell<ScopeState>>,
}
struct Tap {
    port: Handle,
    source: Handle,
    context: *mut Context,
    /// Re-checks Accessibility while armed; dropped first, so no check runs
    /// against a torn-down tap.
    watch: Option<Watch>,
}

// No unsafe Send/Sync: all resources and callbacks are main-run-loop confined.
thread_local! {
    static ACTIVE: RefCell<Option<Tap>> = const { RefCell::new(None) };
}

fn main_thread() -> Result<(), String> {
    // SAFETY: pointer-free CoreFoundation run-loop identity queries.
    if unsafe { CFRunLoopGetMain() == CFRunLoopGetCurrent() } {
        Ok(())
    } else {
        Err("Escape scope must run on the main thread".into())
    }
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY) {
        let _ = window.hide();
    }
}

unsafe extern "C" fn callback(
    _: Handle,
    event_type: u32,
    event: Handle,
    context: Handle,
) -> Handle {
    if context.is_null() {
        return event;
    }
    // The context remains alive until the source is removed and port invalidated.
    // We never tear down a tap inside its callback.
    let context = &*(context as *const Context);
    let key = if event_type == 10 && !event.is_null() {
        CGEventGetIntegerValueField(event, 9)
    } else {
        -1
    };
    let action = context.state.borrow_mut().event(event_type, key);
    if action == Action::Pass {
        return event;
    }
    let session = context.state.borrow().session.clone();
    cancel_dictation(&context.app, session);
    if action == Action::CancelAndSwallow {
        ptr::null_mut()
    } else {
        event
    }
}

fn cancel_dictation(app: &AppHandle, session: String) {
    // Cancellation is latched natively before notifying JS. A concurrent STT
    // response cannot claim delivery even if the notification arrives later.
    if let Some(coordinator) = app.try_state::<crate::capture::coordinator::CaptureCoordinator>() {
        if let Some(status) = coordinator.status() {
            if status.mode == crate::capture::coordinator::CaptureMode::Full {
                coordinator.cancel_request(&status.request_id);
            }
        }
    }
    hide(app);
    let _ = app.emit_to("main", "dictation:cancel", session);
}

/// The watchdog's callout (main run loop, outside the tap callback). With
/// Accessibility gone the tap can't be trusted to pass input, so it is torn
/// down at once, and the dictation fails closed like a disabled tap's.
unsafe extern "C" fn on_watch(_timer: Handle, _info: Handle) {
    if crate::tap_guard::still_trusted() {
        return;
    }
    let Some(tap) = ACTIVE.with(|slot| slot.borrow_mut().take()) else {
        return;
    };
    let action = tap.state().borrow_mut().event(u32::MAX, -1);
    let session = tap.state().borrow().session.clone();
    // SAFETY: the context outlives `tap`; clone what the cancel needs first.
    let app = (*tap.context).app.clone();
    drop(tap);
    if action == Action::Cancel {
        cancel_dictation(&app, session);
    }
}

impl Tap {
    fn install(app: AppHandle, session: String) -> Result<Self, String> {
        let mut state = ScopeState::new(session);
        state.visible = app
            .get_webview_window(OVERLAY)
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        let context = Box::into_raw(Box::new(Context {
            app,
            state: Rc::new(RefCell::new(state)),
        }));
        // SAFETY: create an active (not listen-only) session tap, keyDown only.
        // It passes every event except Escape in a visible, owned session.
        unsafe {
            let port = CGEventTapCreate(1, 0, 0, 1 << 10, callback, context.cast());
            if port.is_null() {
                // SAFETY: regain sole ownership after failed creation (no tap /
                // callbacks). Query non-prompting evidence in this exact process.
                let context = Box::from_raw(context);
                return Err(super::diagnostics::tap_failure_message(
                    AXIsProcessTrusted() != 0,
                    CGPreflightListenEventAccess(),
                    CGPreflightPostEventAccess(),
                    &context.app.config().identifier,
                    &context.app.package_info().version.to_string(),
                ));
            }
            let source = CFMachPortCreateRunLoopSource(ptr::null_mut(), port, 0);
            if source.is_null() {
                CFMachPortInvalidate(port);
                CFRelease(port);
                drop(Box::from_raw(context));
                return Err("Could not create Escape cancellation monitor".into());
            }
            CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            let mut tap = Self {
                port,
                source,
                context,
                watch: None,
            };
            // Without its watchdog the tap could outlive Accessibility, so
            // it is not kept (`tap` drops here and tears down).
            tap.watch = Some(Watch::start(on_watch).ok_or("Could not watch Escape cancellation")?);
            Ok(tap)
        }
    }

    fn state(&self) -> &RefCell<ScopeState> {
        // SAFETY: context is owned by this live tap.
        unsafe { &(*self.context).state }
    }
}
impl Drop for Tap {
    fn drop(&mut self) {
        // SAFETY: main thread, outside callback; stop callbacks before freeing
        // the context. Exactly one owner releases each create-rule object.
        self.watch.take();
        unsafe {
            CGEventTapEnable(self.port, false);
            CFRunLoopRemoveSource(CFRunLoopGetMain(), self.source, kCFRunLoopCommonModes);
            CFMachPortInvalidate(self.port);
            CFRelease(self.source);
            CFRelease(self.port);
            drop(Box::from_raw(self.context));
        }
    }
}

pub fn arm(app: AppHandle, session: String) -> Result<(), String> {
    main_thread()?;
    close();
    let tap = Tap::install(app, session)?;
    ACTIVE.with(|slot| *slot.borrow_mut() = Some(tap));
    Ok(())
}

pub fn finish(app: &AppHandle, session: &str) -> Result<bool, String> {
    main_thread()?;
    let accepted = ACTIVE.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|tap| tap.state().borrow().can_finish(session))
    });
    end(app, session)?;
    Ok(accepted)
}

pub fn end(app: &AppHandle, session: &str) -> Result<(), String> {
    main_thread()?;
    let removed = ACTIVE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot
            .as_ref()
            .is_some_and(|tap| tap.state().borrow().session == session)
        {
            slot.take();
            true
        } else {
            false
        }
    });
    if removed {
        hide(app);
    }
    Ok(())
}

pub fn can_show() -> bool {
    ACTIVE.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|tap| !tap.state().borrow().cancelled)
    })
}

pub fn visible(value: bool) {
    ACTIVE.with(|slot| {
        if let Some(tap) = slot.borrow().as_ref() {
            let mut state = tap.state().borrow_mut();
            state.visible = value && !state.cancelled;
        }
    });
}

pub fn close() {
    ACTIVE.with(|slot| {
        slot.borrow_mut().take();
    });
}
