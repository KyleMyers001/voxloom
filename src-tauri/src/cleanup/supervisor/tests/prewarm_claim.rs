//! BUS-16 3c-2c C2: a dictation admitted while the prewarm loads or warms up
//! claims its worker, even if the warm-up replies while the dictation still
//! re-hashes; and a warmed, unclaimed worker is never handed over.

use super::prewarm::{all_reaped, dictation, idle, prewarm_worker, spawns, started};
use super::*;
use crate::cleanup::test_support::wait_until;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn a_dictation_re_hashing_when_the_warm_up_replies_still_reuses_the_load() {
    // Codex 4321841994 / CR: 0.2 s load, 0.2 s warm-up, 900 ms re-hash.
    let (path, log) = prewarm_worker("claim-rehash", 0.2, 0.2);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("claim-rehash")));
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
        .start(model_file("claim-unused")));
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
pub(super) fn held_slot(supervisor: &WorkerSupervisor, name: &str, warmed: bool) -> ProcessHandle {
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
        owed: 1,
        wake: mpsc::channel().0,
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
    if let Some(super::super::prewarm::Slot::Running { owed, .. }) =
        supervisor.shared.state.lock().unwrap().prewarm.as_mut()
    {
        *owed = 0;
    }
    assert!(!ticket.settle(false), "nothing to keep it for");
    // Warmed and not yet reaped: a dictation now spawns its own worker.
    assert_eq!(dictation(&supervisor, "after-settle").unwrap(), "fresh");
    held.finish();
}

/// A dictation handed over to a load of `load` s, still waiting on it.
pub(super) fn hand_over_a_load(
    name: &str,
    load: f64,
) -> (
    Arc<WorkerSupervisor>,
    PathBuf,
    String,
    thread::JoinHandle<Result<String, SupervisorError>>,
) {
    let (path, log) = prewarm_worker(name, load, 5.0);
    let supervisor = Arc::new(WorkerSupervisor::new(path));
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file(name)));
    let running = Arc::clone(&supervisor);
    let id = format!("{name}-cut");
    let cut = id.clone();
    let run = thread::spawn(move || dictation(&running, &cut));
    assert!(
        wait_until(Duration::from_secs(5), || started(&supervisor))
            && wait_until(Duration::from_secs(5), || spawns(&log) == 1)
    );
    (supervisor, log, id, run)
}

#[test]
fn a_prewarm_that_warms_up_unused_is_ended() {
    let (path, log) = prewarm_worker("warm-unused", 0.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("warm-unused")));
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    assert!(wait_until(Duration::from_secs(5), || all_reaped(&log)));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_handoff_dropped_before_its_frame_reopens_the_load_owing_nothing_more() {
    // A dictation cancelled between the handover and writing its frame.
    let (path, _) = prewarm_worker("claim-unwritten", 0.0, 0.0);
    let supervisor = WorkerSupervisor::with_timeout(path, Duration::from_secs(1));
    let held = held_slot(&supervisor, "claim-unwritten", false);
    let reservation = supervisor.reserve("unwritten".into()).unwrap();
    drop(super::super::handoff::hand_over(&supervisor.shared).expect("claimed"));
    {
        let state = supervisor.shared.state.lock().unwrap();
        let Some(super::super::prewarm::Slot::Running {
            stdin,
            handoff,
            warmed,
            claimed,
            owed,
            ..
        }) = state.prewarm.as_ref()
        else {
            panic!("the load is still there");
        };
        assert!(stdin.is_some() && handoff.is_none());
        assert!(!warmed && !claimed, "open to the next dictation");
        assert_eq!(*owed, 1, "no frame was written, so no reply is owed for it");
    }
    drop(reservation);
    held.finish();
}

#[test]
fn settling_with_a_reply_still_owed_keeps_the_worker() {
    // Codex 4365519849: while the prewarm waited for a claim, the claiming
    // dictation handed over, wrote its frame and was cut off: unclaimed,
    // nobody handed over, one reply owed.
    let (path, _) = prewarm_worker("claim-owed", 0.0, 0.0);
    let supervisor = WorkerSupervisor::with_timeout(path, Duration::from_secs(1));
    let ticket = supervisor.reserve_prewarm().unwrap();
    let held = held_slot(&supervisor, "claim-owed", false);
    assert!(ticket.settle(false), "kept for the next dictation");
    assert!(!ticket.settle(true), "unless the bound ran out");
    held.finish();
}
