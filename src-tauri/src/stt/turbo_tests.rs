use super::*;
use std::sync::{atomic::Ordering, mpsc};
use std::time::Duration;

#[test]
fn invalid_request_ids_cannot_consume_slots_or_terminal_metadata() {
    let runtime = TurboRuntime::default();
    for id in ["", "bad id", "slash/id", &"x".repeat(129)] {
        assert_eq!(
            runtime.prepare(0, id, MODEL_ID).unwrap_err().code,
            "transcribe-failed"
        );
        assert_eq!(runtime.cancel(0, id).unwrap_err().code, "transcribe-failed");
    }
    assert_eq!(runtime.0.registry.lock().unwrap().jobs.len(), 0);
    assert_eq!(runtime.0.registry.lock().unwrap().recent.len(), 0);
}

#[test]
fn cancel_during_uninterruptible_load_retains_reservation_until_runner_drops() {
    let runtime = TurboRuntime::default();
    runtime.prepare(0, "old", MODEL_ID).unwrap();
    let (entered_tx, entered) = mpsc::channel();
    let (finish, finish_rx) = mpsc::channel();
    let old = runtime.clone();
    let thread = std::thread::spawn(move || {
        old.run(0, "old", MODEL_ID, |cancel| {
            entered_tx.send(cancel).unwrap();
            finish_rx.recv().unwrap();
            Ok(42)
        })
    });
    let cancel = entered.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(
        runtime.run(0, "old", MODEL_ID, |_| Ok(0)).is_err(),
        "active request cannot be replayed"
    );
    runtime.cancel(0, "old").unwrap();
    let cancelled_promptly = cancel.load(Ordering::SeqCst);
    runtime.prepare(0, "next", MODEL_ID).unwrap();
    let overflow = runtime.prepare(0, "overflow", MODEL_ID);
    finish.send(()).unwrap();
    let result = thread.join().unwrap();
    assert!(
        cancelled_promptly,
        "actual runner receives cooperative cancellation"
    );
    assert_eq!(
        overflow.unwrap_err().code,
        "busy",
        "cancelled load still owns the heavy slot"
    );
    assert_eq!(
        result.unwrap_err().code,
        "cancelled",
        "no stale successful result"
    );
    assert_eq!(runtime.run(0, "next", MODEL_ID, |_| Ok(7)).unwrap(), 7);
}

fn wait_claimed(runtime: &TurboRuntime, id: &str) {
    let reg = runtime.0.registry.lock().unwrap();
    let (reg, timeout) = runtime
        .0
        .changed
        .wait_timeout_while(reg, Duration::from_secs(3), |reg| {
            !reg.jobs
                .get(id)
                .is_some_and(|job| job.claimed.load(Ordering::SeqCst))
        })
        .unwrap();
    assert!(
        !timeout.timed_out(),
        "runner never reached production claim boundary"
    );
    assert!(reg.jobs.get(id).unwrap().claimed.load(Ordering::SeqCst));
}

#[test]
fn cancel_queued_request_never_invokes_runner_and_frees_only_pending_slot() {
    let runtime = TurboRuntime::default();
    runtime.prepare(0, "active", MODEL_ID).unwrap();
    runtime.prepare(0, "queued", MODEL_ID).unwrap();
    let (entered_tx, entered) = mpsc::channel();
    let (finish, finish_rx) = mpsc::channel();
    let old = runtime.clone();
    let active = std::thread::spawn(move || {
        old.run(0, "active", MODEL_ID, |_| {
            entered_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            Ok(1)
        })
    });
    entered.recv_timeout(Duration::from_secs(3)).unwrap();
    let queued = runtime.clone();
    let pending = std::thread::spawn(move || {
        queued.run(0, "queued", MODEL_ID, |_| -> Result<(), SttErrorDto> {
            panic!("cancelled pending invoked")
        })
    });
    wait_claimed(&runtime, "queued");
    runtime.cancel(0, "queued").unwrap();
    assert_eq!(pending.join().unwrap().unwrap_err().code, "cancelled");
    runtime.prepare(0, "replacement", MODEL_ID).unwrap();
    assert_eq!(
        runtime.prepare(0, "overflow", MODEL_ID).unwrap_err().code,
        "busy"
    );
    finish.send(()).unwrap();
    assert_eq!(
        active.join().unwrap().unwrap(),
        1,
        "ordinary unrelated request still finishes"
    );
}

struct Dropped(Arc<AtomicBool>);
impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[test]
fn superseded_request_finishes_and_successor_waits_for_actual_context_drop() {
    let runtime = TurboRuntime::default();
    runtime.prepare(0, "old", MODEL_ID).unwrap();
    let dropped = Arc::new(AtomicBool::new(false));
    let drop_flag = dropped.clone();
    let (entered_tx, entered) = mpsc::channel();
    let (finish, finish_rx) = mpsc::channel();
    let old = runtime.clone();
    let active = std::thread::spawn(move || {
        old.run(0, "old", MODEL_ID, |_| {
            let _context = Dropped(drop_flag);
            entered_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            Ok("History")
        })
    });
    entered.recv_timeout(Duration::from_secs(3)).unwrap();
    runtime.prepare(0, "new", MODEL_ID).unwrap();
    let (new_entered_tx, new_entered) = mpsc::channel();
    let (new_finish, new_finish_rx) = mpsc::channel();
    let next = runtime.clone();
    let successor = std::thread::spawn(move || {
        next.run(0, "new", MODEL_ID, |cancel| {
            assert!(
                dropped.load(Ordering::SeqCst),
                "no overlap with old heavy context"
            );
            new_entered_tx.send(cancel.clone()).unwrap();
            new_finish_rx.recv().unwrap();
            Ok("new")
        })
    });
    wait_claimed(&runtime, "new");
    assert_eq!(
        runtime
            .0
            .registry
            .lock()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .id,
        "old"
    );
    finish.send(()).unwrap();
    assert_eq!(active.join().unwrap().unwrap(), "History");
    let new_cancel = new_entered.recv_timeout(Duration::from_secs(3)).unwrap();
    runtime.cancel(0, "old").unwrap();
    assert!(
        !new_cancel.load(Ordering::SeqCst),
        "late old release cannot cancel successor"
    );
    new_finish.send(()).unwrap();
    assert_eq!(successor.join().unwrap().unwrap(), "new");
}

#[test]
fn renderer_epoch_retires_live_claims_without_releasing_active_early() {
    let runtime = TurboRuntime::default();
    runtime.prepare(0, "loading", MODEL_ID).unwrap();
    runtime.prepare(0, "not-started", MODEL_ID).unwrap();
    let (entered_tx, entered) = mpsc::channel();
    let (finish, finish_rx) = mpsc::channel();
    let old = runtime.clone();
    let active = std::thread::spawn(move || {
        old.run(0, "loading", MODEL_ID, |cancel| {
            entered_tx.send(cancel).unwrap();
            finish_rx.recv().unwrap();
            Ok(1)
        })
    });
    let cancel = entered.recv_timeout(Duration::from_secs(3)).unwrap();
    runtime.retire_main("settings");
    assert_eq!(runtime.epoch(), 0);
    runtime.retire_main("main");
    assert!(cancel.load(Ordering::SeqCst));
    assert_eq!(runtime.epoch(), 1);
    assert_eq!(
        runtime.prepare(0, "stale", MODEL_ID).unwrap_err().code,
        "cancelled"
    );
    assert_eq!(
        runtime
            .run(0, "not-started", MODEL_ID, |_| Ok(()))
            .unwrap_err()
            .code,
        "cancelled"
    );
    runtime.prepare(1, "successor", MODEL_ID).unwrap();
    assert!(!runtime.cancel(0, "successor").unwrap());
    assert_eq!(
        runtime.prepare(1, "overflow", MODEL_ID).unwrap_err().code,
        "busy"
    );
    finish.send(()).unwrap();
    assert_eq!(active.join().unwrap().unwrap_err().code, "cancelled");
    assert!(runtime.run(1, "successor", MODEL_ID, |_| Ok(())).is_ok());
}

#[test]
fn exact_model_request_single_use_and_recent_ids_are_not_lifetime_quotas() {
    let runtime = TurboRuntime::default();
    runtime.prepare(0, "immutable", MODEL_ID).unwrap();
    assert!(runtime.prepare(0, "immutable", "different").is_err());
    assert!(runtime
        .run(0, "immutable", "different", |_| Ok(()))
        .is_err());
    assert!(runtime.run(0, "immutable", MODEL_ID, |_| Ok(())).is_ok());
    assert!(runtime.run(0, "immutable", MODEL_ID, |_| Ok(())).is_err());
    assert!(runtime.prepare(0, "immutable", MODEL_ID).is_err());
    for i in 0..MAX_RECENT_IDS + 8 {
        let id = format!("completed-{i}");
        runtime.prepare(0, &id, MODEL_ID).unwrap();
        runtime.run(0, &id, MODEL_ID, |_| Ok(())).unwrap();
    }
    assert_eq!(
        runtime.0.registry.lock().unwrap().recent.len(),
        MAX_RECENT_IDS
    );
    assert!(
        runtime.prepare(0, "immutable", MODEL_ID).is_ok(),
        "finite replay window, no lifetime quota"
    );
    assert!(runtime
        .prepare(0, &format!("completed-{}", MAX_RECENT_IDS + 7), MODEL_ID)
        .is_err());
}

#[test]
fn cancelled_active_identity_survives_terminal_id_eviction() {
    let runtime = TurboRuntime::default();
    runtime.prepare(0, "active", MODEL_ID).unwrap();
    let (entered_tx, entered) = mpsc::channel();
    let (finish, finish_rx) = mpsc::channel();
    let old = runtime.clone();
    let active = std::thread::spawn(move || {
        old.run(0, "active", MODEL_ID, |_| {
            entered_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            Ok(())
        })
    });
    entered.recv_timeout(Duration::from_secs(3)).unwrap();
    runtime.cancel(0, "active").unwrap();
    for i in 0..MAX_RECENT_IDS + 1 {
        runtime.cancel(0, &format!("unseen-{i}")).unwrap();
    }
    let readmission = runtime.prepare(0, "active", MODEL_ID);
    finish.send(()).unwrap();
    assert_eq!(active.join().unwrap().unwrap_err().code, "cancelled");
    assert_eq!(readmission.unwrap_err().code, "cancelled");
}
