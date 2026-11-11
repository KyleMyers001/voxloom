use super::*;
use crate::tap_guard::{Disables, TapGuard, Verdict};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::time::Instant;

const TICK: Duration = Duration::from_millis(5);

/// Wait (bounded) until `done` holds. Only waits for an event; no test
/// depends on how long anything takes.
fn eventually(done: impl Fn() -> bool) -> bool {
    for _ in 0..400 {
        if done() {
            return true;
        }
        thread::sleep(TICK);
    }
    false
}

static GRANTED: AtomicBool = AtomicBool::new(true);
static CHECKS: AtomicUsize = AtomicUsize::new(0);

fn fake_check() -> bool {
    CHECKS.fetch_add(1, Ordering::SeqCst);
    GRANTED.load(Ordering::SeqCst)
}

#[test]
fn the_checker_publishes_loss_and_stops_when_nothing_watches() {
    let monitor = Monitor::new(fake_check, TICK);
    GRANTED.store(false, Ordering::SeqCst);
    // A just-created tap proved access, so a new watch starts trusted.
    let watch = monitor.watch().unwrap();
    assert!(watch.trusted());
    // The check runs on the checker thread; the reader only sees the result.
    assert!(eventually(|| !watch.trusted()));
    assert!(CHECKS.load(Ordering::SeqCst) > 0);

    // A new tap (creation succeeded, so access is back) starts trusted, and
    // does not hide the loss from the tap that was watching.
    GRANTED.store(true, Ordering::SeqCst);
    let second = monitor.watch().unwrap();
    assert!(second.trusted());
    assert!(!watch.trusted());

    drop(watch);
    drop(second);
    // `running` clears in the same lock as the thread's exit, so once it
    // reads false no further check can start.
    assert!(eventually(|| !monitor.running()));
    let after = CHECKS.load(Ordering::SeqCst);
    thread::sleep(TICK * 10);
    assert_eq!(
        CHECKS.load(Ordering::SeqCst),
        after,
        "no checks with no watchers"
    );

    // Watching again restarts it.
    GRANTED.store(false, Ordering::SeqCst);
    let again = monitor.watch().unwrap();
    assert!(monitor.running());
    assert!(eventually(|| !again.trusted()));
}

static GATED_ENTERED: AtomicUsize = AtomicUsize::new(0);
static GATED_RELEASED: AtomicUsize = AtomicUsize::new(0);

/// Reports access lost, but each call waits until the test releases it.
fn gated_lost_check() -> bool {
    let call = GATED_ENTERED.fetch_add(1, Ordering::SeqCst) + 1;
    while GATED_RELEASED.load(Ordering::SeqCst) < call {
        thread::sleep(Duration::from_millis(1));
    }
    false
}

#[test]
fn a_check_in_flight_when_a_tap_is_created_cannot_fail_that_tap() {
    let monitor = Monitor::new(gated_lost_check, TICK);
    let old = monitor.watch().unwrap();
    // The first check has started (for `old`'s epoch) and is held.
    assert!(eventually(|| GATED_ENTERED.load(Ordering::SeqCst) >= 1));
    // Access is re-granted and a new tap is created mid-check.
    let new = monitor.watch().unwrap();
    // The held check finishes with "lost".
    GATED_RELEASED.store(1, Ordering::SeqCst);
    // It is real for the tap that was watching when it started...
    assert!(eventually(|| !old.trusted()));
    // ...and stale for the new tap: no spurious access-lost. Any later check
    // is still held, so this is the only result that has landed.
    assert!(new.trusted());

    drop(old);
    drop(new);
    GATED_RELEASED.store(usize::MAX, Ordering::SeqCst);
    assert!(eventually(|| !monitor.running()));
}

fn panicking_check() -> bool {
    panic!("the Accessibility check failed");
}

#[test]
fn a_panicked_checker_fails_closed_and_can_restart() {
    let monitor = Monitor::new(panicking_check, TICK);
    let watch = monitor.watch().unwrap();
    assert!(eventually(|| !watch.trusted()));
    assert!(eventually(|| !monitor.running()));

    // A new tap restarts the checker instead of finding it "running".
    let next = monitor.watch().unwrap();
    assert!(monitor.running());
    assert!(next.trusted());
    assert!(eventually(|| !next.trusted()));
}

/// A check the test steps through: each call reads `granted` when it
/// starts (as the probe does), then waits until the test releases it.
struct Gate {
    granted: AtomicBool,
    entered: AtomicUsize,
    released: AtomicUsize,
}

impl Gate {
    const fn new() -> Self {
        Self {
            granted: AtomicBool::new(true),
            entered: AtomicUsize::new(0),
            released: AtomicUsize::new(0),
        }
    }

    fn run(&self) -> bool {
        let granted = self.granted.load(Ordering::SeqCst);
        let call = self.entered.fetch_add(1, Ordering::SeqCst) + 1;
        while self.released.load(Ordering::SeqCst) < call {
            thread::sleep(Duration::from_millis(1));
        }
        granted
    }

    /// Wait until check `n` has started (it is held until released).
    fn started(&self, n: usize) -> bool {
        eventually(|| self.entered.load(Ordering::SeqCst) >= n)
    }

    fn release(&self, through: usize) {
        self.released.store(through, Ordering::SeqCst);
    }
}

fn user_input() -> Disables {
    let mut disables = Disables::default();
    disables.note(false);
    disables
}

static REVOKE_GATE: Gate = Gate::new();

fn revoke_gate_check() -> bool {
    REVOKE_GATE.run()
}

#[test]
fn a_disable_before_the_first_post_revoke_check_lands_is_never_reenabled() {
    let gate = &REVOKE_GATE;
    let monitor = Monitor::new(revoke_gate_check, TICK);
    let watch = monitor.watch().unwrap();
    let mut guard = TapGuard::default();
    let now = Instant::now();
    // Check 1 started while access was still granted, and is held.
    assert!(gate.started(1));
    // Access is revoked and macOS disables the tap before a check sees it.
    gate.granted.store(false, Ordering::SeqCst);
    assert!(watch.trusted(), "the published flag is stale");
    assert_eq!(
        guard.check(user_input(), watch.snapshot(), now),
        Verdict::AwaitCheck
    );
    // Check 1 lands "granted", but it started before the disable.
    gate.release(1);
    assert!(eventually(|| watch.snapshot().granted == 1));
    assert!(watch.trusted());
    assert_eq!(
        guard.check(Disables::default(), watch.snapshot(), now),
        Verdict::AwaitCheck
    );
    // Check 2 started after the revoke and finds it.
    assert!(gate.started(2));
    gate.release(2);
    assert!(eventually(|| !watch.trusted()));
    assert_eq!(
        guard.check(Disables::default(), watch.snapshot(), now),
        Verdict::TearDown
    );

    drop(watch);
    gate.release(usize::MAX);
    assert!(eventually(|| !monitor.running()));
}

static GRANTED_GATE: Gate = Gate::new();

fn granted_gate_check() -> bool {
    GRANTED_GATE.run()
}

#[test]
fn a_disabled_tap_is_reenabled_once_a_check_started_after_the_disable_passes() {
    let gate = &GRANTED_GATE;
    let monitor = Monitor::new(granted_gate_check, TICK);
    let watch = monitor.watch().unwrap();
    let mut guard = TapGuard::default();
    let now = Instant::now();
    assert!(gate.started(1));
    assert_eq!(
        guard.check(user_input(), watch.snapshot(), now),
        Verdict::AwaitCheck
    );
    // The check in flight at the disable passes; it doesn't count.
    gate.release(1);
    assert!(eventually(|| watch.snapshot().granted == 1));
    assert_eq!(
        guard.check(Disables::default(), watch.snapshot(), now),
        Verdict::AwaitCheck
    );
    // The next one does.
    assert!(gate.started(2));
    gate.release(2);
    assert!(eventually(|| watch.snapshot().granted == 2));
    assert_eq!(
        guard.check(Disables::default(), watch.snapshot(), now),
        Verdict::Reenable
    );
    assert_eq!(
        guard.check(Disables::default(), watch.snapshot(), now),
        Verdict::Keep
    );

    drop(watch);
    gate.release(usize::MAX);
    assert!(eventually(|| !monitor.running()));
}

fn granted_check() -> bool {
    true
}

#[test]
fn a_nudge_runs_the_next_check_without_waiting_out_the_interval() {
    // An interval no test run reaches: only a nudge starts a check in time.
    let monitor = Monitor::new(granted_check, Duration::from_secs(3600));
    let watch = monitor.watch().unwrap();
    watch.nudge();
    assert!(eventually(|| watch.snapshot().granted >= 1));
    let first = watch.snapshot().granted;
    watch.nudge();
    assert!(eventually(|| watch.snapshot().granted > first));
}
