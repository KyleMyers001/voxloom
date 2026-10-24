//! BUS-120: a dictation cut off while handed over to the prewarm's load (its
//! budget ran out, or it was cancelled) leaves that load running: the next
//! dictation reuses it, and with nobody waiting it ends when its last reply
//! is in, or at the prewarm's timeout.

use super::prewarm::{
    all_reaped, decoding_prewarm_worker, dictation, idle, prewarm_worker, spawns, started,
};
use super::prewarm_claim::hand_over_a_load;
use super::*;
use crate::cleanup::test_support::wait_until;
use std::time::{Duration, Instant};

const QUICK: Duration = Duration::from_secs(3);

fn log_has(log: &std::path::Path, line: &str) -> bool {
    fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .any(|l| l == line)
}

#[test]
fn a_cancelled_dictation_leaves_its_load_to_the_next_one() {
    let (supervisor, log, id, run) = hand_over_a_load("keep-cancel", 1.0);
    supervisor.cancel(&id);
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    assert!(!idle(&supervisor), "kept");
    // Its reply is the next dictation's, never the cancelled one's.
    assert_eq!(dictation(&supervisor, "keep-next").unwrap(), "reused");
    assert_eq!(spawns(&log), 1, "never loaded again");
    assert!(log_has(&log, "served keep-next"));
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
}

#[test]
fn a_timed_out_dictation_leaves_its_load_to_the_next_one() {
    let (path, log) = prewarm_worker("keep-timeout", 1.0, 5.0);
    let supervisor = WorkerSupervisor::with_timeout(path, Duration::from_millis(600));
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("keep-timeout")));
    let error = dictation(&supervisor, "keep-late").unwrap_err();
    assert_eq!(error.code, "timeout", "{}", error.message);
    // The load ends about 0.4 s into this one's 0.6 s.
    assert_eq!(dictation(&supervisor, "keep-in-time").unwrap(), "reused");
    assert_eq!(spawns(&log), 1, "never loaded again");
}

#[test]
fn a_kept_load_nobody_reuses_ends_when_its_last_reply_is_in() {
    let (supervisor, log, id, run) = hand_over_a_load("keep-unused", 1.0);
    supervisor.cancel(&id);
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    // Well before the 60 s prewarm timeout.
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
    assert!(
        log_has(&log, &format!("served {id}")),
        "it finished the load"
    );
    assert_eq!(dictation(&supervisor, "keep-after").unwrap(), "fresh");
}

#[test]
fn a_newer_dictation_preempts_the_abandoned_one() {
    // Every reply takes 2 s unless a newer frame stops it.
    let (path, log) = decoding_prewarm_worker("keep-preempt", 0.2, 5.0, 2.0);
    let supervisor = Arc::new(WorkerSupervisor::new(path));
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("keep-preempt")));
    let running = Arc::clone(&supervisor);
    let run = thread::spawn(move || dictation(&running, "keep-first"));
    assert!(wait_until(QUICK, || started(&supervisor)));
    // Past the warm-up: the first dictation's reply is being decoded.
    assert!(wait_until(QUICK, || fs::read_to_string(&log)
        .unwrap_or_default()
        .contains("preempted")));
    supervisor.cancel("keep-first");
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    let begun = Instant::now();
    assert_eq!(dictation(&supervisor, "keep-second").unwrap(), "reused");
    // Its own 2 s, not the rest of the abandoned reply's first.
    assert!(
        begun.elapsed() < Duration::from_millis(3_500),
        "{:?}",
        begun.elapsed()
    );
    assert!(log_has(&log, "abandoned keep-first"));
    assert!(log_has(&log, "served keep-second"));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn the_backstop_can_run_out_during_the_load() {
    let (path, log) = prewarm_worker("prewarm-slow", 30.0, 0.0);
    let mut supervisor = WorkerSupervisor::with_timeout(path, Duration::from_millis(400));
    supervisor.prewarm_timeout = Duration::from_millis(300);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("prewarm-slow")));
    let error = dictation(&supervisor, "slow-load").unwrap_err();
    assert_eq!(error.code, "timeout", "{}", error.message);
    // The load is kept for the next dictation (keep.rs), but nobody waits on
    // it any more: it ends at the prewarm's timeout, not after its 30 s.
    assert!(wait_until(Duration::from_secs(3), || idle(&supervisor)));
    assert!(wait_until(Duration::from_secs(3), || all_reaped(&log)));
    assert_eq!(spawns(&log), 1, "never loaded again");
}

#[test]
fn cancelling_a_handed_over_dictation_keeps_its_load_only_until_the_timeout() {
    let (path, log) = prewarm_worker("prewarm-cancel", 30.0, 0.0);
    let mut supervisor = WorkerSupervisor::new(path);
    supervisor.prewarm_timeout = Duration::from_millis(300);
    let supervisor = Arc::new(supervisor);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("prewarm-cancel")));
    let running = Arc::clone(&supervisor);
    let run = thread::spawn(move || dictation(&running, "cancelled"));
    assert!(wait_until(Duration::from_secs(5), || started(&supervisor)));
    assert!(wait_until(Duration::from_secs(5), || spawns(&log) == 1));
    supervisor.cancel("cancelled");
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    // Kept, not re-armed: one load, ended at its timeout.
    assert!(wait_until(Duration::from_secs(3), || idle(&supervisor)));
    assert!(wait_until(Duration::from_secs(3), || all_reaped(&log)));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_cut_off_restarts_the_orphan_bound() {
    let (path, log) = prewarm_worker("keep-bound", 30.0, 0.0);
    let mut supervisor = WorkerSupervisor::with_timeout(path, Duration::from_millis(800));
    supervisor.prewarm_timeout = Duration::from_millis(600);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("keep-bound")));
    // Cut off past the 0.6 s from the start: the bound runs from here.
    assert_eq!(dictation(&supervisor, "late").unwrap_err().code, "timeout");
    thread::sleep(Duration::from_millis(300));
    assert!(!idle(&supervisor), "kept for the next dictation");
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
    assert_eq!(spawns(&log), 1);
}
