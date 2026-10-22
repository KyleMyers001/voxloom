//! BUS-16 3c-2c: the worker gets the run's time left, counted when it is
//! spawned, and no field at all without a deadline.

use super::*;
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
