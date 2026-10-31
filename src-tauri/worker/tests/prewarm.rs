//! BUS-16 3c-2c C2: a prewarm request loads the model once and warms it up;
//! a request handed over meanwhile reuses that load and preempts the
//! warm-up. BUS-120: the worker serves every request handed over after that,
//! in turn, and a newer one preempts the one it is serving (the app gave up
//! on it) until the app closes stdin. The debug build's fake model (src/test_hook.rs) sets the load
//! time and pace; the ignored test uses a real model.

#[allow(dead_code)] // request() is for the other test binaries
mod common;

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use common::{frame, worker_command};

struct Worker {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    started: Instant,
}

impl Worker {
    fn spawn(fake: Option<&str>, model: Option<&File>) -> Self {
        let mut command = worker_command(model.map(AsRawFd::as_raw_fd));
        if let Some(fake) = fake {
            command.env("VOXLOOM_WORKER_TEST_FAKE_MODEL", fake);
        }
        let mut child = command.stdin(Stdio::piped()).spawn().expect("spawn worker");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let mut worker = Self {
            child,
            stdin,
            stdout,
            started: Instant::now(),
        };
        worker.send(json!({
            "modelPath": "/dev/fd/3", "prompt": "Fix this: hello", "requestId": "prewarm",
            "prewarm": true,
        }));
        worker
    }

    fn send(&mut self, request: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&frame(&request)).unwrap();
        stdin.flush().unwrap();
    }

    fn hand_over(&mut self, time_left_ms: u64) {
        self.hand_over_as("r-2", time_left_ms);
    }

    fn hand_over_as(&mut self, request_id: &str, time_left_ms: u64) {
        self.send(json!({
            "modelPath": "/dev/fd/3", "prompt": "secret words", "requestId": request_id,
            "timeLeftMs": time_left_ms,
        }));
    }

    /// The next reply frame, and when it arrived since the spawn.
    fn reply(&mut self) -> (Value, Duration) {
        let mut header = [0_u8; 4];
        self.stdout.read_exact(&mut header).expect("a reply frame");
        let mut body = vec![0_u8; u32::from_be_bytes(header) as usize];
        self.stdout.read_exact(&mut body).unwrap();
        (
            serde_json::from_slice(&body).unwrap(),
            self.started.elapsed(),
        )
    }

    /// Close stdin, as the app does when it is done with the worker: the
    /// worker never ends by itself after a reply, so another request can
    /// still come.
    fn close(mut self) -> (Option<i32>, Vec<u8>) {
        drop(self.stdin.take());
        let output = self.child.wait_with_output().unwrap();
        (output.status.code(), output.stderr)
    }
}

#[cfg(debug_assertions)]
#[test]
fn a_prewarm_alone_warms_up_and_ends_when_stdin_closes() {
    let mut worker = Worker::spawn(Some("0,10"), None);
    let (reply, _) = worker.reply();
    assert_eq!(reply["status"], "ok", "{reply}");
    assert_eq!(reply["text"], "warm");
    assert_eq!(reply["requestId"], "prewarm");
    let (code, stderr) = worker.close();
    // No dictation came: the app closed stdin (parent.rs exit status).
    assert_eq!(code, Some(4));
    assert!(stderr.is_empty());
}

#[cfg(debug_assertions)]
#[test]
fn a_request_during_the_load_waits_for_it_and_skips_the_warm_up() {
    let mut worker = Worker::spawn(Some("500,10"), None);
    worker.hand_over(10_000);
    let (first, _) = worker.reply();
    assert_eq!(first["text"], "preempted", "{first}");
    let (second, at) = worker.reply();
    assert_eq!(second["status"], "ok", "{second}");
    assert_eq!(second["text"], "xxxxx");
    assert_eq!(second["requestId"], "r-2");
    // One load (500 ms) then the request; no second load, no warm-up.
    assert!(at >= Duration::from_millis(550), "{at:?}");
    assert!(at < Duration::from_millis(1_000), "{at:?}");
    let (code, stderr) = worker.close();
    assert_eq!(code, Some(4));
    assert!(stderr.is_empty());
}

#[cfg(debug_assertions)]
#[test]
fn the_app_going_away_after_a_handover_still_ends_the_worker() {
    // A request handed over during an 800 ms load, then stdin closes (the
    // app quit or died): the worker ends at once, not after its reply.
    let mut worker = Worker::spawn(Some("800,200"), None);
    worker.hand_over(10_000);
    std::thread::sleep(Duration::from_millis(100));
    let closed = Instant::now();
    let (code, _) = worker.close();
    assert_eq!(code, Some(4), "the parent-gone exit status");
    assert!(
        closed.elapsed() < Duration::from_millis(500),
        "{:?}",
        closed.elapsed()
    );
}

#[cfg(debug_assertions)]
#[test]
fn a_request_preempts_the_warm_up_decode() {
    // Warm-up: 5 pieces at 200 ms, about 1.2 s if nothing stops it.
    let mut worker = Worker::spawn(Some("0,200"), None);
    std::thread::sleep(Duration::from_millis(300));
    worker.hand_over(10_000);
    let (first, at) = worker.reply();
    assert_eq!(first["text"], "preempted", "{first}");
    // Stopped at the next piece after the request arrived.
    assert!(at < Duration::from_millis(700), "{at:?}");
    let (second, _) = worker.reply();
    assert_eq!(second["text"], "xxxxx", "{second}");
    assert!(worker.close().1.is_empty());
}

#[cfg(debug_assertions)]
#[test]
fn the_budget_can_run_out_during_the_load() {
    // 1000 ms left on arrival; the load takes 800, which leaves less than
    // the reply margin. Counted from the end of the load it would fit.
    let mut worker = Worker::spawn(Some("800,10"), None);
    worker.hand_over(1_000);
    let (first, _) = worker.reply();
    assert_eq!(first["text"], "preempted", "{first}");
    let (second, _) = worker.reply();
    assert_eq!(second["errorCode"], "timeout", "{second}");
    assert_eq!(second["requestId"], "r-2");
    assert_eq!(worker.close().0, Some(4));
}

#[cfg(debug_assertions)]
#[test]
fn every_request_after_the_warm_up_is_served_on_the_one_load() {
    let mut worker = Worker::spawn(Some("300,10"), None);
    assert_eq!(worker.reply().0["text"], "warm");
    for id in ["r-2", "r-3"] {
        worker.hand_over_as(id, 10_000);
        let (reply, _) = worker.reply();
        assert_eq!(reply["status"], "ok", "{reply}");
        assert_eq!(reply["requestId"], id);
    }
    let (code, stderr) = worker.close();
    assert_eq!(code, Some(4), "ended only when stdin closed");
    assert!(stderr.is_empty());
}

#[cfg(debug_assertions)]
#[test]
fn a_newer_request_preempts_the_one_being_served() {
    // 5 pieces at 300 ms: about 1.5 s per reply if nothing stops it.
    let mut worker = Worker::spawn(Some("0,300"), None);
    worker.hand_over_as("r-2", 10_000);
    assert_eq!(worker.reply().0["text"], "preempted");
    std::thread::sleep(Duration::from_millis(400));
    let sent = Instant::now();
    worker.hand_over_as("r-3", 10_000);
    let (abandoned, _) = worker.reply();
    assert_eq!(abandoned["requestId"], "r-2", "{abandoned}");
    assert_eq!(abandoned["status"], "error", "{abandoned}");
    // Stopped at its next piece, not after its whole reply.
    assert!(
        sent.elapsed() < Duration::from_millis(700),
        "{:?}",
        sent.elapsed()
    );
    let (served, _) = worker.reply();
    assert_eq!(served["requestId"], "r-3", "{served}");
    assert_eq!(served["text"], "xxxxx");
    assert_eq!(worker.close().0, Some(4));
}

#[test]
fn a_failed_load_fails_the_handed_over_request_too() {
    // No model on fd 3 (and no fake): the load fails once, for both frames.
    let mut worker = Worker::spawn(None, None);
    let (first, _) = worker.reply();
    assert_eq!(first["errorCode"], "model-missing", "{first}");
    worker.hand_over(10_000);
    let (second, _) = worker.reply();
    assert_eq!(second["errorCode"], "model-missing", "{second}");
    assert_eq!(second["requestId"], "r-2");
    let (code, stderr) = worker.close();
    assert_eq!(code, Some(4));
    assert!(stderr.is_empty());
}

/// `VOXLOOM_TEST_CLEANUP_MODEL=/path/model.gguf cargo test --release -- --ignored`
#[test]
#[ignore = "needs a real Qwen3 GGUF in VOXLOOM_TEST_CLEANUP_MODEL"]
fn a_real_model_prewarms_and_serves_the_handed_over_request() {
    let path = std::env::var("VOXLOOM_TEST_CLEANUP_MODEL").expect("model path");
    let model = File::open(path).unwrap();
    let mut worker = Worker::spawn(None, Some(&model));
    let (first, warmed) = worker.reply();
    assert_eq!(first["text"], "warm", "{first}");
    worker.send(json!({
        "modelPath": "/dev/fd/3", "requestId": "r-2", "timeLeftMs": 10_000,
        "prompt": "Fix punctuation and capitalization. Reply with the text only.\n\nhello there how are you",
    }));
    let (second, done) = worker.reply();
    assert_eq!(second["status"], "ok", "{second}");
    eprintln!(
        "warm after {warmed:?}, handed-over reply {:?} later",
        done - warmed
    );
    assert!(worker.close().1.is_empty());
}
