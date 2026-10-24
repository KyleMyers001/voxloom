//! BUS-120: how a handed-over dictation cut off before its reply leaves the
//! load (handoff.rs): what it still owes, and when the slot reopens.

use super::super::handoff::hand_over;
use super::super::prewarm::Slot;
use super::super::watch::Delivery;
use super::prewarm::{all_reaped, idle, prewarm_worker};
use super::prewarm_claim::held_slot;
use super::*;
use crate::cleanup::test_support::wait_until;
use crate::cleanup::worker_process::ProcessError;
use std::time::{Duration, Instant};

/// The slot's (stdin back, replies owed), with the load still there.
fn slot(supervisor: &WorkerSupervisor) -> (bool, usize) {
    match supervisor.shared.state.lock().unwrap().prewarm.as_ref() {
        Some(Slot::Running { stdin, owed, .. }) => (stdin.is_some(), *owed),
        _ => panic!("the load is still there"),
    }
}

#[test]
fn a_dictation_cancelled_before_its_frame_writes_none() {
    let (path, _) = prewarm_worker("cut-unsent", 0.0, 0.0);
    let supervisor = WorkerSupervisor::with_timeout(path, Duration::from_secs(1));
    let held = held_slot(&supervisor, "cut-unsent", false);
    let reservation = supervisor.reserve("unsent".into()).unwrap();
    let mut handoff = hand_over(&supervisor.shared).expect("claimed");
    handoff.canceller().send(Delivery::Cancelled).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    match handoff.exchange(b"\0\0\0\x02{}", deadline) {
        Err(ProcessError::Runtime(message)) => assert!(message.contains("cancelled")),
        Err(_) => panic!("not the cancel"),
        Ok(_) => panic!("answered"),
    }
    drop(handoff);
    assert_eq!(slot(&supervisor), (true, 1), "no reply owed for it");
    drop(reservation);
    held.finish();
}

#[test]
fn a_reply_that_comes_in_as_the_dictation_gives_up_keeps_the_slot_closed() {
    let (path, _) = prewarm_worker("cut-race", 0.0, 0.0);
    let supervisor = WorkerSupervisor::with_timeout(path, Duration::from_secs(1));
    let held = held_slot(&supervisor, "cut-race", false);
    let reservation = supervisor.reserve("race".into()).unwrap();
    let handoff = hand_over(&supervisor.shared).expect("claimed");
    // The reader delivers its reply (watch.rs), and the worker is done.
    if let Some(Slot::Running { handoff, .. }) =
        supervisor.shared.state.lock().unwrap().prewarm.as_mut()
    {
        let reply = Err("cleanup worker ended".to_string());
        handoff
            .take()
            .unwrap()
            .send(Delivery::Reply(reply))
            .unwrap();
    }
    drop(handoff);
    assert_eq!(slot(&supervisor), (false, 1), "not reopened to a done load");
    drop(reservation);
    held.finish();
}

#[test]
fn a_claimed_load_whose_handoff_ends_unsent_is_ended() {
    let (path, log) = prewarm_worker("cut-claimed", 0.3, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("cut-claimed")));
    let reservation = supervisor.reserve("claimed".into()).unwrap();
    // The warm-up has replied; the prewarm waits for this claim.
    assert!(wait_until(Duration::from_secs(5), || slot(&supervisor).1 == 0));
    let handoff = hand_over(&supervisor.shared).expect("claimed");
    // Let the prewarm see the handover and wait on it, so the cut-off
    // reaches it as a wake-up rather than as the claim ending.
    thread::sleep(Duration::from_millis(200));
    drop(handoff);
    drop(reservation);
    // Nothing owed and nobody handed over: ended now, not at the 60 s
    // prewarm timeout.
    assert!(wait_until(Duration::from_secs(3), || idle(&supervisor)));
    assert!(wait_until(Duration::from_secs(3), || all_reaped(&log)));
}
