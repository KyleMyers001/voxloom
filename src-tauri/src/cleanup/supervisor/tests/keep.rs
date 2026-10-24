//! BUS-120: a dictation cut off while handed over to the prewarm's load (its
//! budget ran out, or it was cancelled) leaves that load running: the next
//! dictation reuses it, and with nobody waiting it ends when its last reply
//! is in, or at the prewarm's timeout (orphan_bound.rs). A disarm still
//! reaps a kept load.

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
fn disarming_a_kept_load_reaps_it() {
    // BUS-120: a cancelled dictation leaves its 30 s load running for the
    // next one; a disarm reaches it there.
    let (supervisor, log, id, run) = hand_over_a_load("disarm-kept-load", 30.0);
    supervisor.cancel(&id);
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    assert!(!idle(&supervisor), "kept");
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Stopped);
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_disarm_right_after_a_timeout_cut_off_reaps_the_kept_load() {
    // The window the re-arm used to have: cut off by the backstop, not a
    // cancel, and disarmed at once.
    let (path, log) = prewarm_worker("disarm-window", 30.0, 0.0);
    let supervisor = WorkerSupervisor::with_timeout(path, Duration::from_millis(300));
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("disarm-window")));
    assert_eq!(
        dictation(&supervisor, "window").unwrap_err().code,
        "timeout"
    );
    assert_eq!(supervisor.disarm_prewarm(), Disarmed::Stopped);
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
    assert_eq!(spawns(&log), 1, "never loaded again");
}
