//! BUS-16 3c-2 (QA M1): the worker exits soon after the app dies, even
//! mid-generation. The app holds the worker's stdin open until it has the
//! reply, and the kernel closes that pipe however the app ends.
//!
//! A stand-in "app" process holds the only write end of the worker's stdin
//! and is SIGKILLed mid-generation. Without a real model, the debug build's
//! slow fake generation (src/test_hook.rs) keeps the worker busy; the
//! ignored variant uses a real model.

mod common;

use std::fs::File;
use std::io::{pipe, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use common::{request, worker_command};

/// The requirement: gone within about a second of the app.
const EXIT_BOUND: Duration = Duration::from_secs(1);
/// A worker still running this long after the app died fails the test.
const GIVE_UP: Duration = Duration::from_secs(10);

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "needs the debug build's slow fake generation"
)]
fn the_worker_exits_when_the_app_is_killed_mid_generation() {
    let mut running = start(None, "secret words", Duration::from_millis(500));
    running.assert_exits_after_app_death();
}

/// Needs a real Qwen3 GGUF:
/// `VOXLOOM_TEST_CLEANUP_MODEL=/path/model.gguf cargo test -- --ignored`
#[test]
#[ignore = "needs a real Qwen3 GGUF in VOXLOOM_TEST_CLEANUP_MODEL"]
fn a_real_model_worker_exits_when_the_app_is_killed_mid_generation() {
    let path = std::env::var("VOXLOOM_TEST_CLEANUP_MODEL").expect("model path");
    let model = File::open(path).unwrap();
    // A long reply, so generation is still running at the kill.
    let items: Vec<String> = (1..=300).map(|n| format!("item {n}")).collect();
    let prompt = format!(
        "Repeat this list back, one item per line.\n\n{}",
        items.join(", ")
    );
    let busy = Duration::from_secs(5);
    let mut running = start(Some(model.as_raw_fd()), &prompt, busy);
    running.assert_exits_after_app_death();
}

/// The worker and the stand-in app; both are killed on drop, so a failed
/// assertion leaves no process behind.
struct Running {
    worker: Child,
    app: Child,
}

/// Start the worker with the request on stdin, give the only write end of
/// that pipe to the stand-in app, and check the worker is still busy after
/// `busy`. With no `model`, the worker runs the slow fake generation.
fn start(model: Option<RawFd>, prompt: &str, busy: Duration) -> Running {
    let (stdin_reader, mut stdin_writer) = pipe().unwrap();
    stdin_writer
        .write_all(&request("/dev/fd/3", prompt))
        .unwrap();
    let mut command = worker_command(model);
    if model.is_none() {
        command.env("VOXLOOM_WORKER_TEST_SLOW_GENERATION", "1");
    }
    let worker = command.stdin(stdin_reader).spawn().expect("spawn worker");
    // This process's copy of the write end goes with the Command at the end
    // of the statement, leaving the app's as the only one.
    let app = Command::new("sleep")
        .arg("600")
        .stdin(Stdio::null())
        .stdout(stdin_writer)
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn stand-in app");
    let mut running = Running { worker, app };
    sleep(busy);
    let early = running.worker.try_wait().unwrap();
    assert!(
        early.is_none(),
        "the worker ended before the app died: {early:?}"
    );
    running
}

impl Running {
    /// SIGKILL the stand-in app; the worker must then exit within
    /// EXIT_BOUND, silently and without a reply.
    fn assert_exits_after_app_death(&mut self) {
        self.app.kill().unwrap();
        self.app.wait().unwrap();
        let killed = Instant::now();
        let status = loop {
            if let Some(status) = self.worker.try_wait().unwrap() {
                break status;
            }
            assert!(
                killed.elapsed() < GIVE_UP,
                "the worker was still running {GIVE_UP:?} after the app died"
            );
            sleep(Duration::from_millis(5));
        };
        let elapsed = killed.elapsed();
        assert!(
            elapsed <= EXIT_BOUND,
            "exited {elapsed:?} after the app died"
        );
        assert_eq!(status.code(), Some(4), "the app-gone exit status");
        let stdout = read_all(self.worker.stdout.take().unwrap());
        assert!(stdout.is_empty(), "stdout: {stdout:?}");
        let stderr = read_all(self.worker.stderr.take().unwrap());
        let stderr = String::from_utf8_lossy(&stderr);
        assert!(stderr.is_empty(), "stderr: {stderr:?}");
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        for child in [&mut self.worker, &mut self.app] {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn read_all(mut pipe: impl std::io::Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes).unwrap();
    bytes
}
