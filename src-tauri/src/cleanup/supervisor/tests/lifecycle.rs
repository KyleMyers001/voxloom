//! Admission, cancellation and settlement of the single worker slot.

use super::*;

#[test]
fn cancelled_reservation_keeps_the_slot_until_its_owner_settles() {
    let supervisor = WorkerSupervisor::new(success_worker("reserved-cancel"));
    let reservation = supervisor.reserve("reserved".into()).unwrap();
    supervisor.cancel("reserved");
    supervisor.release("reserved");
    assert!(reservation.cancelled());
    assert!(supervisor.reserve("too-early".into()).is_err());
    drop(reservation);
    assert!(supervisor.reserve("after-settlement".into()).is_ok());
}

#[test]
fn overlap_is_rejected_before_either_spawn_completes() {
    let path = success_worker("overlap-before-spawn");
    let supervisor = Arc::new(WorkerSupervisor::new(path.clone()));
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (proceed, wait_proceed) = std::sync::mpsc::channel();
    let first = Arc::clone(&supervisor);
    let first_path = path.clone();
    let running = thread::spawn(move || {
        first.run_with_spawn("p".into(), "first".into(), || {
            entered.send(()).unwrap();
            wait_proceed.recv().unwrap();
            WorkerProcess::spawn(&first_path, &model_file("overlap-a"))
        })
    });
    wait_entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let spawned = std::sync::atomic::AtomicBool::new(false);
    let second = supervisor.run_with_spawn("p".into(), "second".into(), || {
        spawned.store(true, std::sync::atomic::Ordering::SeqCst);
        WorkerProcess::spawn(&path, &model_file("overlap-b"))
    });
    proceed.send(()).unwrap();
    assert_eq!(running.join().unwrap().unwrap(), "cleaned");
    assert!(!spawned.load(std::sync::atomic::Ordering::SeqCst));
    assert!(second.unwrap_err().message.contains("already processing"));
}

#[test]
fn release_cannot_erase_a_cancel_during_spawn() {
    let path = success_worker("cancel-during-spawn");
    let supervisor = Arc::new(WorkerSupervisor::new(path.clone()));
    let (entered, wait_entered) = std::sync::mpsc::channel();
    let (proceed, wait_proceed) = std::sync::mpsc::channel();
    let first = Arc::clone(&supervisor);
    let running = thread::spawn(move || {
        first.run_with_spawn("p".into(), "starting".into(), || {
            entered.send(()).unwrap();
            wait_proceed.recv().unwrap();
            WorkerProcess::spawn(&path, &model_file("spawn-cancel"))
        })
    });
    wait_entered.recv_timeout(Duration::from_secs(5)).unwrap();
    supervisor.cancel("starting");
    supervisor.release("starting");
    proceed.send(()).unwrap();
    assert_eq!(running.join().unwrap().unwrap_err().code, "cancelled");
    assert_eq!(
        supervisor
            .run(&model_file("spawn-cancel-next"), "p".into(), "next".into(),)
            .unwrap(),
        "cleaned"
    );
}

#[test]
fn framed_success_and_recovery_after_malformed_output() {
    let model = model_file("success");
    let success = WorkerSupervisor::with_timeout(success_worker("success"), Duration::from_secs(2));
    assert_eq!(
        success.run(&model, "p".into(), "r1".into()).unwrap(),
        "cleaned"
    );

    let malformed_marker = fake_root("malformed").join("failed-once");
    let malformed_path = fake_worker(
        "malformed",
        &format!(
            r#"{FRAMING}
from pathlib import Path
request = read()
marker = Path(r"{}")
if not marker.exists():
    marker.touch()
    sys.stdout.buffer.write(b'\x00\x00\x00\x02xx')
else:
    write({{"error": None, "errorCode": None,
           "requestId": request["requestId"], "status": "ok",
           "text": "recovered"}})
"#,
            malformed_marker.display()
        ),
    );
    let malformed = WorkerSupervisor::with_timeout(malformed_path, Duration::from_secs(2));
    assert!(malformed.run(&model, "p".into(), "bad".into()).is_err());
    assert_eq!(
        malformed.run(&model, "p".into(), "again".into(),).unwrap(),
        "recovered"
    );
}

#[test]
fn hung_stdin_is_timed_out_reaped_and_next_run_succeeds() {
    let hung = fake_worker("hung-stdin", "import time\ntime.sleep(60)");
    let supervisor = WorkerSupervisor::with_timeout(hung, Duration::from_millis(100));
    let error = supervisor
        .run(
            &model_file("hung"),
            "x".repeat(crate::cleanup::protocol::MAX_FRAME_BYTES - 256),
            "hung".into(),
        )
        .unwrap_err();
    assert_eq!(error.code, "timeout");

    let supervisor =
        WorkerSupervisor::with_timeout(success_worker("after-hung"), Duration::from_secs(2));
    assert!(supervisor
        .run(&model_file("next"), "p".into(), "next".into(),)
        .is_ok());
}

#[test]
fn active_cancel_and_repeated_cancel_do_not_deadlock() {
    let sleeper = fake_worker(
        "cancel",
        &format!(
            r#"{FRAMING}
import time
request = read()
if request["requestId"] == "active":
    time.sleep(60)
write({{"error": None, "errorCode": None,
       "requestId": request["requestId"], "status": "ok", "text": "next"}})
"#
        ),
    );
    let supervisor = Arc::new(WorkerSupervisor::with_timeout(
        sleeper,
        Duration::from_secs(5),
    ));
    let running = Arc::clone(&supervisor);
    let handle =
        thread::spawn(move || running.run(&model_file("active"), "p".into(), "active".into()));
    for _ in 0..100 {
        if supervisor.shared.state.lock().unwrap().active.is_some() {
            break;
        }
        thread::yield_now();
    }
    assert!(supervisor.cancel("queued"));
    assert!(supervisor.cancel("active"));
    assert!(supervisor.cancel("active"));
    let error = handle.join().unwrap().unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert_eq!(
        supervisor
            .run(&model_file("after-cancel"), "p".into(), "next".into(),)
            .unwrap(),
        "next"
    );
    let queued = supervisor
        .run(&model_file("queued"), "p".into(), "queued".into())
        .unwrap_err();
    assert_eq!(queued.code, "cancelled");
}

/// BUS-16 3c-2: the worker exits as soon as its stdin closes (it takes that
/// as the app dying), so the app holds stdin open until the reply is in.
#[test]
fn stdin_stays_open_until_the_reply_is_read() {
    let worker = fake_worker(
        "stdin-open",
        &format!(
            r#"{FRAMING}
import select
request = read()
ready, _, _ = select.select([sys.stdin], [], [], 0.3)
closed = bool(ready) and sys.stdin.buffer.read1(1) == b""
write({{"error": None, "errorCode": None, "requestId": request["requestId"],
       "status": "ok", "text": "closed" if closed else "open"}})
"#
        ),
    );
    let supervisor = WorkerSupervisor::with_timeout(worker, Duration::from_secs(5));
    let text = supervisor
        .run(&model_file("stdin-open"), "p".into(), "open".into())
        .unwrap();
    assert_eq!(text, "open");
}
