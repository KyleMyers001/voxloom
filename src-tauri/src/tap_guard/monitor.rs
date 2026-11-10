//! The checker thread: runs the blocking Accessibility check every
//! `interval` while at least one tap is watched, and publishes the result
//! as an atomic flag. Readers never block on the check.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

pub struct Monitor {
    inner: Arc<Inner>,
}

struct Inner {
    trusted: AtomicBool,
    state: Mutex<State>,
    check: fn() -> bool,
    interval: Duration,
}

#[derive(Default)]
struct State {
    watchers: usize,
    running: bool,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        // The state is two counters; a panic elsewhere can't leave it torn.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// One tap's interest in the flag. Dropping the last one ends the checker
/// within one interval.
pub struct AccessWatch(Arc<Inner>);

impl AccessWatch {
    /// The checker's latest verdict (true until its first check after the
    /// most recent `watch`, which a tap creation had just proven).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn trusted(&self) -> bool {
        self.0.trusted.load(Ordering::SeqCst)
    }
}

impl Drop for AccessWatch {
    fn drop(&mut self) {
        let mut state = self.0.state();
        state.watchers = state.watchers.saturating_sub(1);
    }
}

impl Monitor {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn new(check: fn() -> bool, interval: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                trusted: AtomicBool::new(false),
                state: Mutex::default(),
                check,
                interval,
            }),
        }
    }

    /// Watch on behalf of a tap that was just created. Starts the checker
    /// if it is not running. Only takes a short lock; never runs `check`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn watch(&self) -> Result<AccessWatch, String> {
        let mut state = self.inner.state();
        self.inner.trusted.store(true, Ordering::SeqCst);
        if !state.running {
            let inner = Arc::clone(&self.inner);
            thread::Builder::new()
                .name("tap-access-check".into())
                .spawn(move || run(inner))
                .map_err(|e| format!("Could not start the Accessibility check: {e}"))?;
            state.running = true;
        }
        state.watchers += 1;
        Ok(AccessWatch(Arc::clone(&self.inner)))
    }
}

fn run(inner: Arc<Inner>) {
    loop {
        thread::sleep(inner.interval);
        {
            let mut state = inner.state();
            if state.watchers == 0 {
                state.running = false;
                return;
            }
        }
        let trusted = (inner.check)();
        inner.trusted.store(trusted, Ordering::SeqCst);
    }
}
