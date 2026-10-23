//! BUS-16 3c-2c: the worker gets the run's time left, counted when it is
//! spawned, and no field at all without a deadline.

use super::*;
use crate::cleanup::worker_process::WorkerProcess;
use std::time::{Duration, Instant};

/// Replies with the `timeLeftMs` it was sent (or "absent").
fn echo_worker(name: &str) -> PathBuf {
    fake_worker(
        name,
        &format!(
            r#"{FRAMING}
request = read()
left = request.get("timeLeftMs", "absent")
write({{"error": None, "errorCode": None, "requestId": request["requestId"],
       "status": "ok", "text": str(left)}})
"#
        ),
    )
}

fn sent_time_left(name: &str, deadline: Option<Instant>) -> String {
    let supervisor = WorkerSupervisor::new(echo_worker(name));
    let mut reservation = supervisor.reserve("r".into()).unwrap();
    reservation.set_deadline(deadline);
    reservation
        .run(&model_file(name), "p".into(), || {})
        .unwrap()
}

#[test]
fn the_worker_is_sent_the_time_left_at_spawn() {
    let deadline = Instant::now() + Duration::from_millis(4_000);
    // Time spent before the spawn (the re-hash) is already gone.
    std::thread::sleep(Duration::from_millis(200));
    let sent: u64 = sent_time_left("budget-left", Some(deadline))
        .parse()
        .unwrap();
    assert!((3_000..=3_800).contains(&sent), "{sent}");
}

/// BUS-124: the spawn itself takes `delay` before the worker has its request.
fn sent_time_left_after_slow_spawn(name: &str, deadline: Instant, delay: Duration) -> u64 {
    let supervisor = WorkerSupervisor::new(echo_worker(name));
    let model = model_file(name);
    let worker = supervisor.worker_path.clone();
    let mut reservation = supervisor.reserve("r".into()).unwrap();
    reservation.set_deadline(Some(deadline));
    reservation
        .run_with_spawn("p".into(), || {
            std::thread::sleep(delay);
            WorkerProcess::spawn(&worker, &model)
        })
        .unwrap()
        .parse()
        .unwrap()
}

#[test]
fn the_spawn_time_comes_out_of_the_time_left_sent_to_the_worker() {
    let deadline = Instant::now() + Duration::from_millis(4_000);
    let sent =
        sent_time_left_after_slow_spawn("budget-slow-spawn", deadline, Duration::from_millis(700));
    // Counted from the spawn's end (about 3.3 s), not from before it (4 s).
    assert!((2_300..=3_350).contains(&sent), "{sent}");
}

#[test]
fn a_spawn_that_outlasts_the_deadline_sends_zero() {
    let deadline = Instant::now() + Duration::from_millis(100);
    let sent =
        sent_time_left_after_slow_spawn("budget-spawn-late", deadline, Duration::from_millis(300));
    assert_eq!(sent, 0);
}

#[test]
fn a_slow_spawn_with_no_deadline_still_sends_nothing() {
    let supervisor = WorkerSupervisor::new(echo_worker("budget-slow-none"));
    let model = model_file("budget-slow-none");
    let worker = supervisor.worker_path.clone();
    let sent = supervisor
        .reserve("r".into())
        .unwrap()
        .run_with_spawn("p".into(), || {
            std::thread::sleep(Duration::from_millis(50));
            WorkerProcess::spawn(&worker, &model)
        })
        .unwrap();
    assert_eq!(sent, "absent");
}

#[test]
fn a_passed_deadline_sends_zero_and_none_sends_nothing() {
    let past = Instant::now();
    std::thread::sleep(Duration::from_millis(5));
    assert_eq!(sent_time_left("budget-past", Some(past)), "0");
    assert_eq!(sent_time_left("budget-none", None), "absent");
}

#[test]
fn the_default_worker_timeout_is_the_backstop() {
    let supervisor = WorkerSupervisor::new(echo_worker("budget-backstop"));
    assert_eq!(supervisor.timeout, crate::cleanup::budget::WORKER_TIMEOUT);
    assert_eq!(supervisor.timeout, Duration::from_secs(12));
}
