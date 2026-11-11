//! The Escape tap's Accessibility watchdog (BUS-209). The tap lives on the
//! main run loop, so a repeating main-run-loop timer reads the checker
//! thread's flag (`crate::tap_guard`); the blocking probe never runs on
//! main. The Escape tap is never re-enabled, so there is no budget: on loss
//! the timer's callout tears the tap down.

use std::{ffi::c_void, ptr};

type Handle = *mut c_void;
type Callout = unsafe extern "C" fn(Handle, Handle);

/// How often the armed tap reads the Accessibility flag (the key taps' slice).
const INTERVAL_S: f64 = 0.25;

/// CFRunLoopTimerContext; all null (the callout needs no `info`).
#[repr(C)]
struct TimerContext {
    version: isize,
    info: Handle,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFAbsoluteTimeGetCurrent() -> f64;
    fn CFRunLoopTimerCreate(
        allocator: Handle,
        fire_date: f64,
        interval: f64,
        flags: usize,
        order: isize,
        callout: Callout,
        context: *mut TimerContext,
    ) -> Handle;
    fn CFRunLoopAddTimer(run_loop: Handle, timer: Handle, mode: *const c_void);
    fn CFRunLoopTimerInvalidate(timer: Handle);
    fn CFRunLoopGetMain() -> Handle;
    fn CFRelease(value: *const c_void);
    static kCFRunLoopCommonModes: *const c_void;
}

/// A repeating main-run-loop timer, invalidated and released on drop.
pub(super) struct Watch(Handle);

impl Watch {
    /// Start calling `callout` every `INTERVAL_S` on the main run loop. The
    /// callout gets no context: it finds the armed tap on its own.
    pub(super) fn start(callout: Callout) -> Option<Self> {
        // SAFETY: a create-rule timer with no context, added to the main run
        // loop (which retains it) and kept until `drop` releases it.
        unsafe {
            let first = CFAbsoluteTimeGetCurrent() + INTERVAL_S;
            let timer = CFRunLoopTimerCreate(
                ptr::null_mut(),
                first,
                INTERVAL_S,
                0,
                0,
                callout,
                ptr::null_mut(),
            );
            if timer.is_null() {
                return None;
            }
            CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopCommonModes);
            Some(Self(timer))
        }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        // SAFETY: main thread; invalidating from the timer's own callout is
        // allowed, and it removes the timer from every run loop mode.
        unsafe {
            CFRunLoopTimerInvalidate(self.0);
            CFRelease(self.0);
        }
    }
}
