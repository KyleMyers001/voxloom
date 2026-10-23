//! BUS-121: switching cleanup off disarms the prewarm in every window (model
//! hash, load, warm-up, re-armed load) and never touches a dictation.

use super::prewarm::{all_reaped, dictation, idle, never, prewarm_worker, spawns};
use super::prewarm_claim::hand_over_a_load;
use super::*;
use crate::cleanup::test_support::wait_until;
use std::sync::atomic::{AtomicBool, Ordering};
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
    assert!(!ticket.start(model_file("disarm-hash"), never));
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
            .start(model_file(name), never));
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
fn disarming_a_re_armed_load_reaps_it() {
    let (supervisor, log, id, run) = hand_over_a_load("disarm-rearmed", never);
    supervisor.cancel(&id);
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    assert!(wait_until(WAIT, || spawns(&log) == 2), "re-armed");
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Stopped);
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
    assert_eq!(spawns(&log), 2);
}

static DISARMED: AtomicBool = AtomicBool::new(false);

/// Read just before the re-arm: holds it until the disarm has happened.
fn after_the_disarm() -> bool {
    wait_until(WAIT, || DISARMED.load(Ordering::SeqCst));
    false
}

#[test]
fn a_disarm_between_the_cut_off_and_the_re_arm_cancels_the_re_arm() {
    let (supervisor, log, id, run) = hand_over_a_load("disarm-window", after_the_disarm);
    supervisor.cancel(&id);
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    let _ = supervisor.disarm_prewarm();
    DISARMED.store(true, Ordering::SeqCst);
    assert!(wait_until(QUICK, || idle(&supervisor)));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(spawns(&log), 1, "never re-armed");
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
        .start(model_file("disarm-idle"), never));
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
        .start(model_file("disarm-kept"), never));
    let running = Arc::clone(&supervisor);
    let started = Instant::now();
    let run = thread::spawn(move || dictation(&running, "kept"));
    assert!(wait_until(WAIT, || {
        let state = supervisor.shared.state.lock().unwrap();
        state.active.as_ref().is_some_and(|a| a.process.is_some())
    }));
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Kept);
    assert_eq!(run.join().unwrap().unwrap(), "reused");
    assert!(started.elapsed() >= Duration::from_millis(800));
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
        .start(model_file("disarm-claim"), never));
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
fn a_disarmed_load_a_dictation_used_is_not_re_armed_when_it_is_cut_off() {
    let (supervisor, log, id, run) = hand_over_a_load("disarm-no-rearm", never);
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Kept);
    supervisor.cancel(&id);
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    assert!(wait_until(QUICK, || idle(&supervisor)));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(spawns(&log), 1, "never re-armed");
    assert!(wait_until(QUICK, || all_reaped(&log)));
}

#[test]
fn a_dictation_right_after_a_disarm_gets_its_own_worker() {
    let (path, log) = prewarm_worker("disarm-then-dictate", 30.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("disarm-then-dictate"), never));
    assert!(wait_until(WAIT, || spawns(&log) == 1));
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Stopped);
    // At once: the dying load is closed to claims, not handed this dictation.
    assert_eq!(dictation(&supervisor, "right-after").unwrap(), "fresh");
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
}

#[test]
fn a_disarm_ends_with_its_prewarm_and_the_next_one_is_re_armed_again() {
    let (supervisor, log, _, run) = hand_over_a_load("disarm-ends", never);
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Kept);
    // The dictation gets its reply (the 1 s load, then the 5 s warm-up cut
    // short for it) and the prewarm is over.
    assert_eq!(run.join().unwrap().unwrap(), "reused");
    assert!(wait_until(QUICK, || idle(&supervisor)));
    let again = Arc::clone(&supervisor);
    let ticket = supervisor.reserve_prewarm().unwrap();
    assert!(ticket.start(model_file("disarm-ends-again"), never));
    let run = thread::spawn(move || dictation(&again, "second"));
    assert!(wait_until(WAIT, || spawns(&log) == 2));
    supervisor.cancel("second");
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    assert!(
        wait_until(WAIT, || spawns(&log) == 3),
        "a new prewarm is not born disarmed"
    );
}

#[test]
fn a_load_nobody_disarmed_stays_for_the_next_dictation_after_a_claim_ends_unused() {
    let (path, log) = prewarm_worker("disarm-not-armed", 1.0, 5.0);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("disarm-not-armed"), never));
    assert!(wait_until(WAIT, || spawns(&log) == 1));
    // A dictation claims the load and ends without using it.
    drop(supervisor.reserve("gave-up".into()).unwrap());
    std::thread::sleep(Duration::from_millis(200));
    assert!(!idle(&supervisor), "still loading");
    assert_eq!(dictation(&supervisor, "next").unwrap(), "reused");
    assert_eq!(spawns(&log), 1, "never a second load");
}
