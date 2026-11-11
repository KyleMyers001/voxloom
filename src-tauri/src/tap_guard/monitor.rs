//! The checker thread: runs the blocking Accessibility check every
//! `interval` while at least one tap is watched, and publishes the result.
//! Readers never block on the check.
//!
//! Each `watch` opens a new epoch. A check is tagged with the epoch it
//! started in, and a loss it finds applies only to watches from that epoch
//! or earlier. So a check already in flight when a new tap was created
//! can't fail that tap with a stale result, and a new tap can't hide a loss
//! from the taps that were watching when it was found. A loss is final for
//! the watches it covers: their taps tear down.
//!
//! Checks are also numbered in the order they start, and the newest one that
//! found access granted is published. A disabled tap waits for a check that
//! started after the disable (see `TapGuard`), since the published flag can
//! predate a revoke that caused it; `nudge` runs that check without waiting
//! out the interval.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

#[cfg(test)]
#[path = "monitor_tests.rs"]
mod tests;

pub struct Monitor {
    inner: Arc<Inner>,
}

struct Inner {
    /// Bumped by every `watch`, under the state lock.
    epoch: AtomicU64,
    /// The newest epoch a check found access lost in (0: never).
    lost_through: AtomicU64,
    /// The number of the newest check that has started (0: none yet).
    /// Bumped under the state lock, just before the check runs.
    started: AtomicU64,
    /// The number of the newest check that found access granted (0: none).
    granted: AtomicU64,
    state: Mutex<State>,
    /// Wakes the checker early (`AccessWatch::nudge`).
    wake: Condvar,
    check: fn() -> bool,
    interval: Duration,
}

#[derive(Default)]
struct State {
    watchers: usize,
    running: bool,
    /// Run the next check now instead of after the interval.
    nudged: bool,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        // The state is two counters; a panic elsewhere can't leave it torn.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn mark_lost(&self, epoch: u64) {
        self.lost_through.fetch_max(epoch, Ordering::SeqCst);
    }

    /// Wait out the interval unless nudged. A spurious wake-up only runs a
    /// check early.
    fn wait<'a>(&self, state: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        if state.nudged {
            return state;
        }
        match self.wake.wait_timeout(state, self.interval) {
            Ok((state, _)) => state,
            Err(e) => e.into_inner().0,
        }
    }
}

/// What the checker has published, as one watch sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Access {
    /// See `AccessWatch::trusted`.
    pub trusted: bool,
    /// The number of the newest check that has started (0: none yet).
    pub started: u64,
    /// The number of the newest check that found access granted (0: none).
    pub granted: u64,
}

/// One tap's interest in the result. Dropping the last one ends the checker
/// within one interval.
pub struct AccessWatch {
    inner: Arc<Inner>,
    epoch: u64,
}

impl AccessWatch {
    /// False once a check that started after this watch found access lost
    /// (or the checker died). True until then: the tap's creation had just
    /// proven access.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn trusted(&self) -> bool {
        self.inner.lost_through.load(Ordering::SeqCst) < self.epoch
    }

    /// The latest published results. `trusted` is read last, so a loss
    /// that lands while this reads is not missed behind a newer `granted`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn snapshot(&self) -> Access {
        let granted = self.inner.granted.load(Ordering::SeqCst);
        let started = self.inner.started.load(Ordering::SeqCst);
        Access {
            trusted: self.trusted(),
            started,
            granted,
        }
    }

    /// Ask the checker to run its next check now. Only takes the short
    /// state lock (never held across a check), so a tap thread may call it.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn nudge(&self) {
        self.inner.state().nudged = true;
        self.inner.wake.notify_one();
    }
}

impl Drop for AccessWatch {
    fn drop(&mut self) {
        let mut state = self.inner.state();
        state.watchers = state.watchers.saturating_sub(1);
    }
}

impl Monitor {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn new(check: fn() -> bool, interval: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                epoch: AtomicU64::new(0),
                lost_through: AtomicU64::new(0),
                started: AtomicU64::new(0),
                granted: AtomicU64::new(0),
                state: Mutex::default(),
                wake: Condvar::new(),
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
        if !state.running {
            let inner = Arc::clone(&self.inner);
            thread::Builder::new()
                .name("tap-access-check".into())
                .spawn(move || run(inner))
                .map_err(|e| format!("Could not start the Accessibility check: {e}"))?;
            state.running = true;
        }
        state.watchers += 1;
        let epoch = self.inner.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(AccessWatch {
            inner: Arc::clone(&self.inner),
            epoch,
        })
    }

    #[cfg(test)]
    fn running(&self) -> bool {
        self.inner.state().running
    }
}

/// Lets a new `watch` restart a checker that panicked, and fails every
/// current watch closed instead of leaving them on their last good result.
struct PanicGuard<'a>(&'a Inner);

impl Drop for PanicGuard<'_> {
    fn drop(&mut self) {
        if thread::panicking() {
            let mut state = self.0.state();
            self.0.mark_lost(self.0.epoch.load(Ordering::SeqCst));
            state.running = false;
        }
    }
}

fn run(inner: Arc<Inner>) {
    let _guard = PanicGuard(&inner);
    loop {
        let (epoch, number) = {
            let mut state = inner.wait(inner.state());
            state.nudged = false;
            if state.watchers == 0 {
                state.running = false;
                return;
            }
            (
                inner.epoch.load(Ordering::SeqCst),
                inner.started.fetch_add(1, Ordering::SeqCst) + 1,
            )
        };
        if (inner.check)() {
            inner.granted.fetch_max(number, Ordering::SeqCst);
        } else {
            inner.mark_lost(epoch);
        }
    }
}
