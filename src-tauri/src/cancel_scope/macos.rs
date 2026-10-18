use super::{Action, ScopeState};
use std::{cell::RefCell, ffi::c_void, ptr, rc::Rc};
use tauri::{AppHandle, Emitter, Manager};

const OVERLAY: &str = "dictation-overlay";
type Handle = *mut c_void;
type Callback = unsafe extern "C" fn(Handle, u32, Handle, Handle) -> Handle;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // Apple AXUIElement.h: Boolean (UInt8), available since macOS 10.4.
    // No options/prompting; queries this app process, not an external helper.
    fn AXIsProcessTrusted() -> u8;
    fn CGEventTapCreate(
        location: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: Callback,
        context: Handle,
    ) -> Handle;
    fn CGEventGetIntegerValueField(event: Handle, field: u32) -> i64;
    fn CGEventTapEnable(tap: Handle, enable: bool);
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    // Apple CGEvent.h: bool; macOS 10.15 (the app's minimum). Preflight only:
    // never call the corresponding CGRequest* APIs or change TCC state here.
    fn CGPreflightListenEventAccess() -> bool;
    fn CGPreflightPostEventAccess() -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(allocator: Handle, tap: Handle, order: isize) -> Handle;
    fn CFMachPortInvalidate(tap: Handle);
    fn CFRunLoopGetMain() -> Handle;
    fn CFRunLoopGetCurrent() -> Handle;
    fn CFRunLoopAddSource(loop_: Handle, source: Handle, mode: *const c_void);
    fn CFRunLoopRemoveSource(loop_: Handle, source: Handle, mode: *const c_void);
    fn CFRelease(value: *const c_void);
    static kCFRunLoopCommonModes: *const c_void;
}

struct Context {
    app: AppHandle,
    state: Rc<RefCell<ScopeState>>,
}
struct Tap {
    port: Handle,
    source: Handle,
    context: *mut Context,
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
    // Cancellation is latched natively before notifying JS. A concurrent STT
    // response cannot claim delivery even if the notification arrives later.
    if let Some(coordinator) = context
        .app
        .try_state::<crate::capture::coordinator::CaptureCoordinator>()
    {
        if let Some(status) = coordinator.status() {
            if status.mode == crate::capture::coordinator::CaptureMode::Full {
                coordinator.cancel_request(&status.request_id);
            }
        }
    }
    hide(&context.app);
    let _ = context.app.emit_to("main", "dictation:cancel", session);
    if action == Action::CancelAndSwallow {
        ptr::null_mut()
    } else {
        event
    }
}

impl Tap {
    fn install(app: AppHandle, session: String) -> Result<Self, super::ArmError> {
        // Start hidden even if a passive result banner is still on screen; only
        // the cancellable overlay_show marks the scope visible.
        let state = ScopeState::new(session);
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
                return Err("Could not create Escape cancellation monitor"
                    .to_string()
                    .into());
            }
            CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            Ok(Self {
                port,
                source,
                context,
            })
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

pub fn arm(app: AppHandle, session: String) -> Result<(), super::ArmError> {
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
