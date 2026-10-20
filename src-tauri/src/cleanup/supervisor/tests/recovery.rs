//! Timeouts, crashes, oversize frames and startup errors recover the slot.

use super::*;
use crate::cleanup::protocol::WorkerRequest;

#[test]
fn late_timed_out_output_cannot_poison_the_next_request() {
    let worker = fake_worker(
        "late",
        &format!(
            r#"{FRAMING}
import time
request = read()
if request["requestId"] == "late":
    time.sleep(60)
write({{"error": None, "errorCode": None,
       "requestId": request["requestId"], "status": "ok", "text": "cleaned"}})
"#
        ),
    );
    let supervisor = WorkerSupervisor::with_timeout(
        worker,
        // Permit normal parallel Python startup on the recovery request;
        // the timeout path deliberately stalls far beyond this deadline.
        Duration::from_secs(3),
    );
    let late = supervisor
        .run(&model_file("late"), "p".into(), "late".into())
        .unwrap_err();
    assert_eq!(late.code, "timeout");
    assert!(late.message.contains("3 seconds"));
    assert_eq!(
        supervisor
            .run(&model_file("after-late"), "p".into(), "next".into(),)
            .unwrap(),
        "cleaned"
    );
}

#[test]
fn mismatched_output_and_crash_are_recoverable() {
    let mismatch = fake_worker(
        "mismatch",
        &format!(
            r#"{FRAMING}
read()
write({{"error": None, "errorCode": None, "requestId": "other",
       "status": "ok", "text": "late"}})
"#
        ),
    );
    let supervisor = WorkerSupervisor::with_timeout(mismatch, Duration::from_secs(2));
    assert!(supervisor
        .run(&model_file("mismatch"), "p".into(), "expected".into(),)
        .unwrap_err()
        .message
        .contains("mismatch"));

    let crash_marker = fake_root("crash").join("failed-once");
    let crash_worker = fake_worker(
        "crash",
        &format!(
            r#"{FRAMING}
from pathlib import Path
request = read()
marker = Path(r"{}")
if not marker.exists():
    marker.touch()
    sys.exit(1)
write({{"error": None, "errorCode": None,
       "requestId": request["requestId"], "status": "ok",
       "text": "recovered"}})
"#,
            crash_marker.display()
        ),
    );
    let crash = WorkerSupervisor::with_timeout(crash_worker, Duration::from_secs(2));
    assert!(crash
        .run(&model_file("crash"), "p".into(), "crash".into(),)
        .is_err());
    assert_eq!(
        crash
            .run(&model_file("after-crash"), "p".into(), "next".into(),)
            .unwrap(),
        "recovered"
    );
}

#[test]
fn released_prestart_cancel_does_not_poison_reused_request_id() {
    let supervisor =
        WorkerSupervisor::with_timeout(success_worker("released-cancel"), Duration::from_secs(2));
    assert!(supervisor.cancel("remount-request"));
    supervisor.release("remount-request");
    assert_eq!(
        supervisor
            .run(
                &model_file("released-cancel"),
                "p".into(),
                "remount-request".into(),
            )
            .unwrap(),
        "cleaned"
    );
}

#[test]
fn serialized_oversize_is_rejected_before_spawn_and_slot_recovers() {
    let supervisor = WorkerSupervisor::new(success_worker("frame-limit"));
    for prompt in [
        "x".repeat(crate::cleanup::protocol::MAX_FRAME_BYTES),
        "\0".repeat(crate::cleanup::protocol::MAX_FRAME_BYTES / 6),
        "é".repeat(crate::cleanup::protocol::MAX_FRAME_BYTES / 2),
        "\\\"".repeat(crate::cleanup::protocol::MAX_FRAME_BYTES / 4),
    ] {
        let spawned = std::cell::Cell::new(false);
        let error = supervisor
            .run_with_spawn(prompt, "oversize".into(), || {
                spawned.set(true);
                Err("unexpected spawn".into())
            })
            .unwrap_err();
        assert!(!spawned.get(), "oversize must fail before spawning");
        assert_eq!(error.code, "context-overflow");
    }
    assert_eq!(
        supervisor
            .run(&model_file("frame-limit"), "p".into(), "next".into())
            .unwrap(),
        "cleaned"
    );
}

#[test]
fn exact_serialized_frame_limit_is_accepted() {
    let request = WorkerRequest {
        model_path: "/dev/fd/3".into(),
        prompt: String::new(),
        request_id: "r".into(),
        time_left_ms: None,
    };
    let overhead = serde_json::to_vec(&request).unwrap().len();
    let prompt = "x".repeat(crate::cleanup::protocol::MAX_FRAME_BYTES - overhead);
    let supervisor = WorkerSupervisor::new(success_worker("frame-exact"));
    assert_eq!(
        supervisor
            .run(&model_file("frame-exact"), prompt, "r".into())
            .unwrap(),
        "cleaned"
    );
}

#[test]
fn startup_error_survives_empty_id_and_broken_stdin() {
    let worker = fake_worker(
        "startup-error",
        &format!(
            r#"{FRAMING}
write({{"error": "model descriptor unavailable", "errorCode": "model-missing",
       "requestId": "", "status": "error", "text": None}})
"#
        ),
    );
    let supervisor = WorkerSupervisor::new(worker);
    // Larger than pipe capacity: child deliberately exits without reading.
    let error = supervisor
        .run(
            &model_file("startup-error"),
            "x".repeat(100_000),
            "r".into(),
        )
        .unwrap_err();
    assert_eq!(error.code, "model-missing");
    assert_eq!(error.message, "model descriptor unavailable");
}
