//! A dedicated thread that owns one CGEventTap from creation to teardown
//! (BUS-209). An active tap holds each event until its callback returns, so
//! it must not share the main run loop: a main-thread stall (a sync command,
//! WebKit work) would lag typing and clicks everywhere, and past the tap
//! timeout macOS disables the tap. The thread creates the tap, runs its own
//! run loop until stopped, then tears the tap down itself, so nothing frees
//! tap state while its callback may be running.
//!
//! The lifecycle below is plain `std` (tested everywhere); the run-loop glue
//! at the bottom is macOS only.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle, ThreadId};

/// Set once the owner asks the thread to stop.
#[derive(Clone, Default)]
pub struct Stopping(Arc<AtomicBool>);

impl Stopping {
    pub fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The thread's one setup report: `Ok(handle)` once the tap is listening,
/// or why it could not start. Returns whether the owner is still waiting.
pub struct Ready<H>(mpsc::Sender<Result<H, String>>);

impl<H> Ready<H> {
    pub fn report(self, result: Result<H, String>) -> bool {
        self.0.send(result).is_ok()
    }
}

/// A running tap thread. Always end it with `stop`.
pub struct TapThread<H> {
    handle: H,
    stopping: Stopping,
    thread: JoinHandle<()>,
}

/// Run `body` on a new thread and wait for its setup report. `body` sets up,
/// reports, runs until `Stopping` is set, then tears down; on a setup error
/// it cleans up, reports the error and returns.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn spawn<H: Send + 'static>(
    name: &str,
    body: impl FnOnce(Ready<H>, Stopping) + Send + 'static,
) -> Result<TapThread<H>, String> {
    let (ready, setup) = mpsc::channel();
    let stopping = Stopping::default();
    let flag = stopping.clone();
    let thread = thread::Builder::new()
        .name(name.into())
        .spawn(move || body(Ready(ready), flag))
        .map_err(|e| format!("Could not start the shortcut key monitor: {e}"))?;
    let result = setup
        .recv()
        .unwrap_or_else(|_| Err("The shortcut key monitor stopped while starting".into()));
    match result {
        Ok(handle) => Ok(TapThread {
            handle,
            stopping,
            thread,
        }),
        Err(e) => {
            let _ = thread.join();
            Err(e)
        }
    }
}

impl<H> TapThread<H> {
    /// Set `Stopping`, `wake` the thread, and wait for its teardown. From the
    /// tap thread itself (its own callback) it cannot wait: it returns at
    /// once and the thread tears down when the callback returns.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn stop(self, wake: impl FnOnce(&H)) {
        self.stopping.0.store(true, Ordering::SeqCst);
        wake(&self.handle);
        if !self.is_current(thread::current().id()) {
            let _ = self.thread.join();
        }
    }

    fn is_current(&self, id: ThreadId) -> bool {
        self.thread.thread().id() == id
    }
}

#[cfg(target_os = "macos")]
pub use run_loop::{run_until_stopped, RunLoop};

#[cfg(target_os = "macos")]
mod run_loop {
    use super::Stopping;
    use std::ffi::c_void;

    type Handle = *mut c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRunLoopGetCurrent() -> Handle;
        fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, once: u8) -> i32;
        fn CFRunLoopStop(run_loop: Handle);
        fn CFRetain(value: *const c_void) -> *const c_void;
        fn CFRelease(value: *const c_void);
        static kCFRunLoopDefaultMode: *const c_void;
    }

    /// A retained reference to a tap thread's run loop, used to stop it.
    pub struct RunLoop(Handle);

    // SAFETY: CFRunLoopStop is documented thread-safe; the ref is retained.
    unsafe impl Send for RunLoop {}

    impl RunLoop {
        pub fn current() -> Self {
            // SAFETY: the current thread's run loop, retained for the owner.
            unsafe { Self(CFRetain(CFRunLoopGetCurrent()) as Handle) }
        }

        pub fn stop(&self) {
            // SAFETY: a live, retained run loop.
            unsafe { CFRunLoopStop(self.0) }
        }
    }

    impl Drop for RunLoop {
        fn drop(&mut self) {
            // SAFETY: balances the retain in `current`.
            unsafe { CFRelease(self.0) }
        }
    }

    /// Run this thread's run loop until `stopping` is set. The timeout only
    /// bounds a stop that lands before the loop starts waiting.
    pub fn run_until_stopped(stopping: &Stopping) {
        while !stopping.is_set() {
            // SAFETY: runs the current thread's own run loop.
            unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, 0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    #[test]
    fn a_setup_error_is_returned_and_the_thread_ends() {
        let result = spawn::<()>("t", |ready, _| {
            ready.report(Err("no tap".into()));
        });
        assert_eq!(result.err().as_deref(), Some("no tap"));
    }

    #[test]
    fn a_thread_that_never_reports_is_an_error_not_a_hang() {
        let result = spawn::<()>("t", |ready, _| drop(ready));
        assert!(result.is_err());
    }

    #[test]
    fn stop_wakes_the_thread_and_waits_for_its_teardown() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&log);
        let tap = spawn("t", move |ready, stopping| {
            seen.lock().unwrap().push("listening");
            assert!(ready.report(Ok(7)));
            while !stopping.is_set() {
                thread::sleep(Duration::from_millis(1));
            }
            seen.lock().unwrap().push("torn down");
        })
        .unwrap();
        let mut woken = None;
        tap.stop(|handle| woken = Some(*handle));
        assert_eq!(woken, Some(7));
        assert_eq!(*log.lock().unwrap(), ["listening", "torn down"]);
    }

    #[test]
    fn stop_from_the_tap_thread_returns_and_teardown_follows() {
        let slot: Arc<Mutex<Option<TapThread<()>>>> = Arc::default();
        let (done_tx, done) = mpsc::channel();
        let own = Arc::clone(&slot);
        let tap = spawn("t", move |ready, stopping| {
            ready.report(Ok(()));
            // Stand-in for a callback that disarms its own tap.
            let me = loop {
                if let Some(me) = own.lock().unwrap().take() {
                    break me;
                }
                thread::sleep(Duration::from_millis(1));
            };
            me.stop(|_| {});
            assert!(stopping.is_set());
            done_tx.send("torn down").unwrap();
        })
        .unwrap();
        *slot.lock().unwrap() = Some(tap);
        let teardown = done.recv_timeout(Duration::from_secs(5));
        assert_eq!(teardown, Ok("torn down"));
    }
}
