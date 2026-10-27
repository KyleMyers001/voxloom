//! BUS-16 3c-2c C2: a dictation admitted while the prewarm loads or warms up
//! claims its worker, even if the warm-up replies while the dictation still
//! re-hashes; a warmed, unclaimed worker is never handed over; and a load cut
//! off with a handed-over dictation is re-armed.

use super::prewarm::{all_reaped, dictation, idle, never, prewarm_worker, spawns};
use super::*;
use crate::cleanup::test_support::wait_until;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

fn always() -> bool {
    true
}

#[test]
fn a_dictation_re_hashing_when_the_warm_up_replies_still_reuses_the_load() {
    // Codex 4321841994 / CR: 0.2 s load, 0.2 s warm-up, 900 ms re-hash.
    let (path, log) = prewarm_worker("claim-rehash", 0.2, 0.2);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("claim-rehash"), never));
    let mut reservation = supervisor.reserve("rehash".into()).unwrap();
    // The lease re-hash, between admission and the run.
    thread::sleep(Duration::from_millis(900));
    let model = model_file("claim-rehash-run");
    assert_eq!(
        reservation.run(&model, "p".into(), || {}).unwrap(),
        "reused"
    );
    drop(reservation);
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    assert_eq!(spawns(&log), 1, "never a second load");
}

#[test]
fn a_claim_that_ends_unused_ends_the_worker() {
    let (path, log) = prewarm_worker("claim-unused", 0.1, 0.1);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("claim-unused"), never));
    let reservation = supervisor.reserve("unused".into()).unwrap();
    thread::sleep(Duration::from_millis(600));
    assert!(!idle(&supervisor), "kept for the claiming dictation");
    drop(reservation);
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    assert!(wait_until(Duration::from_secs(5), || all_reaped(&log)));
    assert_eq!(dictation(&supervisor, "after-unused").unwrap(), "fresh");
}

/// A prewarm worker in the slot by hand, with no reader: the window between
/// the warm-up's reply and the reap, held open. A handoff to it would never
/// get a reply.
fn held_slot(supervisor: &WorkerSupervisor, name: &str, warmed: bool) -> ProcessHandle {
    let (process, stdin, _stdout) =
        WorkerProcess::spawn(&supervisor.worker_path, &model_file(name))
            .unwrap()
            .into_parts();
    supervisor.shared.state.lock().unwrap().prewarm = Some(super::super::prewarm::Slot::Running {
        process: process.clone(),
        stdin: Some(stdin),
        handoff: None,
        warmed,
        claimed: false,
    });
    process
}

#[test]
fn a_warmed_unclaimed_worker_is_not_handed_over() {
    let (path, log) = prewarm_worker("claim-warmed", 0.0, 0.0);
    let supervisor = WorkerSupervisor::with_timeout(path, Duration::from_secs(1));
    let held = held_slot(&supervisor, "claim-warmed", true);
    assert_eq!(dictation(&supervisor, "after-warm").unwrap(), "fresh");
    held.finish();
    // The held worker never got a frame, so only the fresh one logged.
    assert_eq!(spawns(&log), 1);
}

#[test]
fn settling_without_a_claim_closes_the_handoff() {
    let (path, _) = prewarm_worker("claim-settle", 0.0, 0.0);
    let supervisor = WorkerSupervisor::with_timeout(path, Duration::from_secs(1));
    let ticket = supervisor.reserve_prewarm().unwrap();
    let held = held_slot(&supervisor, "claim-settle", false);
    assert!(ticket.settle().is_none());
    // Warmed and not yet reaped: a dictation now spawns its own worker.
    assert_eq!(dictation(&supervisor, "after-settle").unwrap(), "fresh");
    held.finish();
}

/// A dictation handed over to a 1 s load, still waiting on it.
pub(super) fn hand_over_a_load(
    name: &str,
    low_power_mode: LowPowerMode,
) -> (
    Arc<WorkerSupervisor>,
    PathBuf,
    String,
    thread::JoinHandle<Result<String, SupervisorError>>,
) {
    let (path, log) = prewarm_worker(name, 1.0, 5.0);
    let supervisor = Arc::new(WorkerSupervisor::new(path));
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file(name), low_power_mode));
    let running = Arc::clone(&supervisor);
    let id = format!("{name}-cut");
    let cut = id.clone();
    let run = thread::spawn(move || dictation(&running, &cut));
    assert!(
        wait_until(Duration::from_secs(5), || {
            let state = supervisor.shared.state.lock().unwrap();
            state.active.as_ref().is_some_and(|a| a.process.is_some())
        }) && wait_until(Duration::from_secs(5), || spawns(&log) == 1)
    );
    (supervisor, log, id, run)
}

/// A dictation handed over to a 1 s load and cancelled at once.
fn cancel_a_handed_over_load(
    name: &str,
    low_power_mode: LowPowerMode,
) -> (Arc<WorkerSupervisor>, PathBuf) {
    let (supervisor, log, id, run) = hand_over_a_load(name, low_power_mode);
    supervisor.cancel(&id);
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    (supervisor, log)
}

#[test]
fn a_cut_off_load_is_re_armed_and_the_next_dictation_reuses_it() {
    let (supervisor, log) = cancel_a_handed_over_load("rearm", never);
    assert!(wait_until(Duration::from_secs(5), || spawns(&log) == 2));
    // The re-armed load is the next dictation's: no third, concurrent one.
    assert_eq!(dictation(&supervisor, "after-rearm").unwrap(), "reused");
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    assert_eq!(spawns(&log), 2);
    assert!(wait_until(Duration::from_secs(5), || all_reaped(&log)));
}

#[test]
fn low_power_mode_skips_the_re_arm() {
    let (supervisor, log) = cancel_a_handed_over_load("rearm-low-power", always);
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_prewarm_that_warms_up_unused_is_not_re_armed() {
    let (path, log) = prewarm_worker("rearm-unused", 0.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("rearm-unused"), never));
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(spawns(&log), 1);
}

static SECOND_ADMITTED: AtomicBool = AtomicBool::new(false);

/// Read just before the re-arm: holds it until the next dictation is in.
fn after_the_second_dictation() -> bool {
    wait_until(Duration::from_secs(5), || {
        SECOND_ADMITTED.load(Ordering::SeqCst)
    });
    false
}

#[test]
fn the_re_arm_waits_for_a_dictation_that_got_in_first() {
    let (supervisor, log) = cancel_a_handed_over_load("rearm-wait", after_the_second_dictation);
    let mut second = supervisor.reserve("second".into()).unwrap();
    SECOND_ADMITTED.store(true, Ordering::SeqCst);
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        spawns(&log),
        1,
        "no re-armed load beside the dictation's own"
    );
    let model = model_file("rearm-wait-second");
    assert_eq!(second.run(&model, "p".into(), || {}).unwrap(), "fresh");
    drop(second);
    // Then the re-arm goes ahead.
    assert!(wait_until(Duration::from_secs(5), || spawns(&log) == 3));
}
