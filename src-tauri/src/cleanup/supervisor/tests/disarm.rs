//! BUS-121: switching cleanup off disarms the prewarm in every window (model
//! hash, load, warm-up, a load kept after a cut-off) and never touches a
//! dictation.

use super::prewarm::{all_reaped, dictation, idle, prewarm_worker, spawns, started};
use super::prewarm_claim::hand_over_a_load;
use super::*;
use crate::cleanup::test_support::wait_until;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(5);
/// Well under the 60 s prewarm timeout and the workers' own 30 s loads.
const QUICK: Duration = Duration::from_secs(3);

#[test]
fn disarming_during_the_hash_stops_it_and_never_spawns() {
    let (path, log) = prewarm_worker("disarm-hash", 0.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    let ticket = supervisor.reserve_prewarm().unwrap();
    assert!(!ticket.abandoned());
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Stopped);
    assert!(ticket.abandoned(), "the hash stops at its next chunk");
    assert!(!ticket.start(model_file("disarm-hash")));
    assert!(idle(&supervisor));
    assert_eq!(spawns(&log), 0);
    assert_eq!(dictation(&supervisor, "after-hash").unwrap(), "fresh");
}

#[test]
fn disarming_during_the_load_or_the_warm_up_reaps_the_worker() {
    // (load s, warm-up s): in the load, and in the warm-up decode.
    for (name, load, warm) in [("disarm-load", 30.0, 0.0), ("disarm-warm", 0.0, 30.0)] {
        let (path, log) = prewarm_worker(name, load, warm);
        let supervisor = WorkerSupervisor::new(path);
        assert!(supervisor
            .reserve_prewarm()
            .unwrap()
            .start(model_file(name)));
        assert!(wait_until(WAIT, || spawns(&log) == 1));
        assert_eq!(supervisor.disarm_prewarm(), Disarmed::Stopped);
        assert!(wait_until(QUICK, || idle(&supervisor)), "{name}");
        assert!(wait_until(QUICK, || all_reaped(&log)), "{name}");
        // Not re-armed, and a dictation spawns its own worker.
        assert_eq!(spawns(&log), 1);
        assert_eq!(dictation(&supervisor, name).unwrap(), "fresh");
    }
}

#[test]
fn disarming_with_nothing_armed_is_a_no_op_and_does_not_stick() {
    let (path, log) = prewarm_worker("disarm-idle", 0.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Nothing);
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Nothing);
    assert!(idle(&supervisor));
    assert!(!supervisor.shared.state.lock().unwrap().prewarm_disarmed);
    // The next prewarm is not born disarmed.
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("disarm-idle")));
    assert!(wait_until(WAIT, || spawns(&log) == 1));
    assert!(wait_until(WAIT, || idle(&supervisor)));
}

#[test]
fn a_disarm_never_touches_a_dictation_on_its_own_worker() {
    let (path, log) = prewarm_worker("disarm-own", 0.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    let mut reservation = supervisor.reserve("own".into()).unwrap();
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Nothing);
    assert!(!reservation.cancelled());
    let model = model_file("disarm-own-run");
    assert_eq!(reservation.run(&model, "p".into(), || {}).unwrap(), "fresh");
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_disarm_leaves_a_handed_over_dictation_its_reply() {
    let (path, log) = prewarm_worker("disarm-kept", 0.8, 5.0);
    let supervisor = Arc::new(WorkerSupervisor::new(path));
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("disarm-kept")));
    let running = Arc::clone(&supervisor);
    let begun = Instant::now();
    let run = thread::spawn(move || dictation(&running, "kept"));
    assert!(wait_until(WAIT, || started(&supervisor)));
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Kept);
    assert_eq!(run.join().unwrap().unwrap(), "reused");
    assert!(begun.elapsed() >= Duration::from_millis(800));
    assert!(wait_until(WAIT, || idle(&supervisor)));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_disarm_with_a_dictation_claiming_the_load_keeps_it_until_the_claim_ends() {
    let (path, log) = prewarm_worker("disarm-claim", 30.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("disarm-claim")));
    assert!(wait_until(WAIT, || spawns(&log) == 1));
    let reservation = supervisor.reserve("claim".into()).unwrap();
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Kept);
    std::thread::sleep(Duration::from_millis(400));
    assert!(!idle(&supervisor), "kept for the claiming dictation");
    // The dictation gives up before handing over: the disarmed load ends now
    // instead of at its warm-up reply.
    drop(reservation);
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_disarmed_load_a_dictation_used_is_not_kept_when_it_is_cut_off() {
    let (supervisor, log, id, run) = hand_over_a_load("disarm-not-kept", 30.0);
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Kept);
    supervisor.cancel(&id);
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    // Ended with the dictation, not after its 30 s load.
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_dictation_right_after_a_disarm_gets_its_own_worker() {
    let (path, log) = prewarm_worker("disarm-then-dictate", 30.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("disarm-then-dictate")));
    assert!(wait_until(WAIT, || spawns(&log) == 1));
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Stopped);
    // At once: the dying load is closed to claims, not handed this dictation.
    assert_eq!(dictation(&supervisor, "right-after").unwrap(), "fresh");
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
}

#[test]
fn a_disarm_ends_with_its_prewarm_and_the_next_one_is_kept_again() {
    let (supervisor, log, _, run) = hand_over_a_load("disarm-ends", 1.0);
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Kept);
    // The dictation gets its reply (the 1 s load, then the 5 s warm-up cut
    // short for it) and the prewarm is over.
    assert_eq!(run.join().unwrap().unwrap(), "reused");
    assert!(wait_until(QUICK, || idle(&supervisor)));
    let again = Arc::clone(&supervisor);
    let ticket = supervisor.reserve_prewarm().unwrap();
    assert!(ticket.start(model_file("disarm-ends-again")));
    let run = thread::spawn(move || dictation(&again, "second"));
    assert!(wait_until(WAIT, || spawns(&log) == 2 && started(&supervisor)));
    supervisor.cancel("second");
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    // A new prewarm is not born disarmed: its cut-off load is kept.
    assert!(!supervisor.shared.state.lock().unwrap().prewarm_disarmed);
    assert_eq!(dictation(&supervisor, "third").unwrap(), "reused");
    assert_eq!(spawns(&log), 2);
}

#[test]
fn a_load_nobody_disarmed_stays_for_the_next_dictation_after_a_claim_ends_unused() {
    let (path, log) = prewarm_worker("disarm-not-armed", 1.0, 5.0);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("disarm-not-armed")));
    assert!(wait_until(WAIT, || spawns(&log) == 1));
    // A dictation claims the load and ends without using it.
    drop(supervisor.reserve("gave-up".into()).unwrap());
    std::thread::sleep(Duration::from_millis(200));
    assert!(!idle(&supervisor), "still loading");
    assert_eq!(dictation(&supervisor, "next").unwrap(), "reused");
    assert_eq!(spawns(&log), 1, "never a second load");
}
