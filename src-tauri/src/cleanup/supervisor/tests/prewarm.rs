//! BUS-16 3c-2c C2: one prewarm at a time, a dictation reuses its load and
//! preempts its warm-up, and nothing ever loads the model twice at once.

use super::*;
use crate::cleanup::test_support::wait_until;
use std::time::{Duration, Instant};

/// A fake worker that logs each spawn (and a preempted warm-up) to `log`.
/// As a prewarm it "loads" for `load` s and warms up for `warm` s unless a
/// frame arrives; it then serves that frame, or the next one, as "reused".
/// A normal request is answered "fresh".
fn prewarm_worker(name: &str, load: f64, warm: f64) -> (PathBuf, PathBuf) {
    let log = fake_root(name).with_extension("log");
    let _ = fs::remove_file(&log);
    let path = fake_worker(
        name,
        &format!(
            r#"{FRAMING}
import os, select, time
def raw(n):
    data = b""
    while len(data) < n:
        chunk = os.read(0, n - len(data))
        if not chunk:
            sys.exit(4)
        data += chunk
    return data
def frame():
    return json.loads(raw(struct.unpack('>I', raw(4))[0]))
def note(line):
    with open({log:?}, "a") as f:
        f.write(line + "\n")
def reply(request_id, text):
    write({{"error": None, "errorCode": None, "requestId": request_id,
           "status": "ok", "text": text}})
first = frame()
note("spawn")
if not first.get("prewarm"):
    reply(first["requestId"], "fresh")
    sys.exit(0)
time.sleep({load})
handed = None
end = time.time() + {warm}
while handed is None and time.time() < end:
    if select.select([0], [], [], 0.01)[0]:
        handed = frame()
        note("preempted")
reply("prewarm", "preempted" if handed else "warm")
handed = handed or frame()
reply(handed["requestId"], "reused")
"#
        ),
    );
    (path, log)
}

fn spawns(log: &std::path::Path) -> usize {
    fs::read_to_string(log)
        .unwrap_or_default()
        .matches("spawn")
        .count()
}

fn idle(supervisor: &WorkerSupervisor) -> bool {
    supervisor.shared.state.lock().unwrap().prewarm.is_none()
}

fn dictation(supervisor: &WorkerSupervisor, name: &str) -> Result<String, SupervisorError> {
    supervisor.run(&model_file(name), "p".into(), name.into())
}

#[test]
fn one_prewarm_runs_in_the_background_then_frees_its_slot() {
    let (path, log) = prewarm_worker("prewarm-alone", 0.1, 0.1);
    let supervisor = WorkerSupervisor::new(path);
    let ticket = supervisor.reserve_prewarm().unwrap();
    assert!(
        supervisor.reserve_prewarm().is_none(),
        "at most one prewarm"
    );
    assert!(ticket.start(model_file("prewarm-alone")));
    assert!(supervisor.reserve_prewarm().is_none());
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    assert_eq!(spawns(&log), 1);
    // Warmed and closed: the next dictation spawns its own worker.
    assert_eq!(dictation(&supervisor, "prewarm-after").unwrap(), "fresh");
    assert_eq!(spawns(&log), 2);
}

#[test]
fn a_dictation_during_the_load_reuses_it() {
    let (path, log) = prewarm_worker("prewarm-load", 0.6, 5.0);
    let supervisor = WorkerSupervisor::new(path);
    let started = Instant::now();
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("prewarm-load")));
    assert_eq!(dictation(&supervisor, "during-load").unwrap(), "reused");
    assert!(started.elapsed() >= Duration::from_millis(600));
    // It waited for the one load, then took priority over the warm-up.
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    assert_eq!(spawns(&log), 1, "never a second load");
}

#[test]
fn a_dictation_preempts_the_warm_up_decode() {
    let (path, log) = prewarm_worker("prewarm-warm", 0.0, 5.0);
    let supervisor = WorkerSupervisor::new(path);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("prewarm-warm")));
    std::thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    assert_eq!(dictation(&supervisor, "during-warm").unwrap(), "reused");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    assert!(fs::read_to_string(&log).unwrap().contains("preempted"));
    assert_eq!(spawns(&log), 1);
}

#[test]
fn the_backstop_can_run_out_during_the_load() {
    let (path, log) = prewarm_worker("prewarm-slow", 30.0, 0.0);
    let supervisor = WorkerSupervisor::with_timeout(path, Duration::from_millis(400));
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("prewarm-slow")));
    let error = dictation(&supervisor, "slow-load").unwrap_err();
    assert_eq!(error.code, "timeout", "{}", error.message);
    // The timed-out dictation reaped the worker, so the prewarm ends too.
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
    assert_eq!(spawns(&log), 1);
}

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
fn a_dictation_before_the_spawn_abandons_the_prewarm() {
    let (path, log) = prewarm_worker("prewarm-abandoned", 0.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    let ticket = supervisor.reserve_prewarm().unwrap();
    // The model is still being hashed: nothing is loading yet.
    let reservation = supervisor.reserve("first".into()).unwrap();
    assert!(!ticket.start(model_file("prewarm-abandoned")));
    assert!(idle(&supervisor));
    assert_eq!(spawns(&log), 0);
    drop(reservation);
    assert_eq!(dictation(&supervisor, "after-abandon").unwrap(), "fresh");
}

#[test]
fn no_prewarm_starts_while_a_dictation_holds_the_slot() {
    let (path, _) = prewarm_worker("prewarm-busy", 0.0, 0.0);
    let supervisor = WorkerSupervisor::new(path);
    let reservation = supervisor.reserve("running".into()).unwrap();
    assert!(supervisor.reserve_prewarm().is_none());
    drop(reservation);
    assert!(supervisor.reserve_prewarm().is_some());
}

#[test]
fn a_prewarm_that_never_warms_up_is_ended() {
    let (path, _) = prewarm_worker("prewarm-stuck", 30.0, 0.0);
    let mut supervisor = WorkerSupervisor::new(path);
    supervisor.prewarm_timeout = Duration::from_millis(300);
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("prewarm-stuck")));
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
}

#[test]
fn cancelling_a_handed_over_dictation_ends_the_prewarm_worker() {
    let (path, _) = prewarm_worker("prewarm-cancel", 30.0, 0.0);
    let supervisor = Arc::new(WorkerSupervisor::new(path));
    assert!(supervisor
        .reserve_prewarm()
        .unwrap()
        .start(model_file("prewarm-cancel")));
    let running = Arc::clone(&supervisor);
    let run = thread::spawn(move || dictation(&running, "cancelled"));
    assert!(wait_until(Duration::from_secs(5), || {
        supervisor
            .shared
            .state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .is_some_and(|a| a.process.is_some())
    }));
    supervisor.cancel("cancelled");
    assert_eq!(run.join().unwrap().unwrap_err().code, "cancelled");
    assert!(wait_until(Duration::from_secs(5), || idle(&supervisor)));
}
