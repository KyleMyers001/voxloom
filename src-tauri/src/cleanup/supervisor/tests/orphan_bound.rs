//! BUS-120: how long a load nobody is handed over to is kept. A dictation
//! handed over is never limited by it; with nobody handed over, a load ends
//! at the prewarm's timeout, counted from the start or the last cut-off.

use super::prewarm::{
    all_reaped, decoding_prewarm_worker, dictation, idle, prewarm_worker, spawns, started,
};
use super::*;
use crate::cleanup::test_support::wait_until;
use std::time::{Duration, Instant};

const QUICK: Duration = Duration::from_secs(3);

#[test]
fn a_handed_over_dictation_outlasts_the_prewarm_timeout() {
    // The load runs past the prewarm's own timeout, but a dictation waits on
    // it: the worker is kept, and the dictation gets its reply, not the
    // prewarm's late one.
    let (path, log) = prewarm_worker("prewarm-late", 0.8, 5.0);
    let mut supervisor = WorkerSupervisor::new(path);
    supervisor.prewarm_timeout = Duration::from_millis(300);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("prewarm-late")));
    assert_eq!(dictation(&supervisor, "late").unwrap(), "reused");
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_prewarm_that_never_warms_up_is_ended() {
    let (path, log) = prewarm_worker("prewarm-stuck", 30.0, 0.0);
    let mut supervisor = WorkerSupervisor::new(path);
    supervisor.prewarm_timeout = Duration::from_millis(300);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("prewarm-stuck")));
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    assert!(all_reaped(&log), "the worker is killed and reaped");
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

#[test]
fn a_cut_off_during_the_first_wait_restarts_the_orphan_bound() {
    // Codex 4365519852: the dictation hands over and is cut off while the
    // prewarm still waits out its first bound, so it never sees it handed
    // over.
    let (path, log) = prewarm_worker("bound-first", 30.0, 0.0);
    let mut supervisor = WorkerSupervisor::with_timeout(path, Duration::from_millis(600));
    supervisor.prewarm_timeout = Duration::from_millis(1_000);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("bound-first")));
    let begun = Instant::now();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(dictation(&supervisor, "first").unwrap_err().code, "timeout");
    // Cut off at about 0.7 s: kept until about 1.7 s, not 1.0 s.
    thread::sleep(Duration::from_millis(1_300).saturating_sub(begun.elapsed()));
    assert!(!idle(&supervisor), "the bound runs from the cut-off");
    assert!(wait_until(QUICK, || idle(&supervisor)));
    assert!(wait_until(QUICK, || all_reaped(&log)));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn a_discarded_reply_does_not_extend_the_orphan_bound() {
    // Cut off at about 0.1 s; the warm-up's reply, owed to nobody, comes in
    // at about 0.8 s; the abandoned dictation's would take 30 s more.
    let (path, log) = decoding_prewarm_worker("bound-discard", 0.8, 0.0, 30.0);
    let mut supervisor = WorkerSupervisor::with_timeout(path, Duration::from_millis(100));
    supervisor.prewarm_timeout = Duration::from_millis(1_000);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("bound-discard")));
    let begun = Instant::now();
    assert_eq!(
        dictation(&supervisor, "discard").unwrap_err().code,
        "timeout"
    );
    // Ended about 1.1 s in, not 1.0 s after the warm-up's reply.
    let left = Duration::from_millis(1_500).saturating_sub(begun.elapsed());
    assert!(
        wait_until(left, || idle(&supervisor)),
        "{:?}",
        begun.elapsed()
    );
    assert!(wait_until(QUICK, || all_reaped(&log)));
}
