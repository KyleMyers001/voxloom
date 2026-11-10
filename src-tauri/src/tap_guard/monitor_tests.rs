use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize};

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
