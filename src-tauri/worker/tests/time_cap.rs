//! BUS-16 3c-2c: the worker caps its reply by the time the app says is
//! left, and reports reaching that cap as `timeout`. Without a real model,
//! the debug build's slow fake generation (src/test_hook.rs, one piece per
//! 10 ms) stands in for a model that cannot finish in time; the ignored
//! variants use a real model.

#[allow(dead_code)] // request() is for the other test binaries
mod common;

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use common::{frame, worker_command};

/// One request with `time_left_ms`, against `model` or (None) the slow hook.
fn run(time_left_ms: u64, model: Option<&File>, prompt: &str) -> (Value, Vec<u8>, Duration) {
    let mut command = worker_command(model.map(AsRawFd::as_raw_fd));
    if model.is_none() {
        command.env("VOXLOOM_WORKER_TEST_SLOW_GENERATION", "1");
    }
    let mut child = command.stdin(Stdio::piped()).spawn().expect("spawn worker");
    let started = Instant::now();
    let mut stdin = child.stdin.take().unwrap();
    let request = json!({
        "modelPath": "/dev/fd/3", "prompt": prompt, "requestId": "r-9",
        "timeLeftMs": time_left_ms,
    });
    stdin.write_all(&frame(&request)).unwrap();
    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .unwrap();
    let elapsed = started.elapsed();
    let output = child.wait_with_output().expect("wait worker");
    drop(stdin);
    assert!(stdout.len() > 4, "no reply frame");
    (
        serde_json::from_slice(&stdout[4..]).unwrap(),
        output.stderr,
        elapsed,
    )
}

#[cfg(debug_assertions)]
fn run_slow(time_left_ms: u64) -> (Value, Vec<u8>, Duration) {
    run(time_left_ms, None, "secret words")
}

#[cfg(debug_assertions)]
#[test]
fn a_reply_that_cannot_fit_the_time_left_is_a_timeout() {
    // 700 ms - 300 ms margin at 22 tokens/s: 8 pieces, then the cap.
    let (reply, stderr, elapsed) = run_slow(700);
    assert_eq!(reply["status"], "error", "{reply}");
    assert_eq!(reply["errorCode"], "timeout", "{reply}");
    assert_eq!(reply["error"], "cleanup ran out of time");
    assert_eq!(reply["requestId"], "r-9");
    assert!(stderr.is_empty());
    // Stopped by the cap, well inside the time it was given.
    assert!(elapsed < Duration::from_millis(700), "{elapsed:?}");
}

#[cfg(debug_assertions)]
#[test]
fn no_time_left_still_answers_at_once() {
    let (reply, _, elapsed) = run_slow(0);
    assert_eq!(reply["errorCode"], "timeout", "{reply}");
    assert!(elapsed < Duration::from_millis(500), "{elapsed:?}");
}

fn real_model() -> File {
    File::open(std::env::var("VOXLOOM_TEST_CLEANUP_MODEL").expect("model path")).unwrap()
}

const PROMPT: &str =
    "Fix punctuation and capitalization. Reply with the text only.\n\nhello there how are you";

/// `VOXLOOM_TEST_CLEANUP_MODEL=/path/model.gguf cargo test --release -- --ignored`
#[test]
#[ignore = "needs a real Qwen3 GGUF in VOXLOOM_TEST_CLEANUP_MODEL"]
fn a_real_model_with_time_left_cleans_and_without_it_times_out() {
    let model = real_model();
    let (reply, stderr, _) = run(10_000, Some(&model), PROMPT);
    assert_eq!(reply["status"], "ok", "{reply}");
    assert!(stderr.is_empty());
    // Inside the margin nothing fits: a timeout after load and prefill.
    let (reply, stderr, _) = run(300, Some(&model), PROMPT);
    assert_eq!(reply["errorCode"], "timeout", "{reply}");
    assert!(stderr.is_empty());
}
