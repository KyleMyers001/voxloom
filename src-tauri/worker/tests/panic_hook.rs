//! BUS-16 10555 L3 (mutant W11): a panic in the worker writes only the fixed
//! message to stderr, never its payload, which may quote the dictated text.
//! The debug build's test hook (src/test_hook.rs) panics with the prompt in
//! the payload. A panic ends the worker with no reply frame; the app treats
//! that as a runtime error and keeps the raw text. Debug builds only: release
//! builds have no such hook.
#![cfg(debug_assertions)]

mod common;

use std::io::{Read, Write};
use std::process::Stdio;

use common::{request, worker_command};

#[test]
fn a_panic_prints_the_fixed_message_and_no_request_text() {
    let mut child = worker_command(None)
        .env("VOXLOOM_WORKER_TEST_PANIC", "1")
        .stdin(Stdio::piped())
        .spawn()
        .expect("spawn worker");
    // Like the app, keep stdin open until the worker is done, so the exit
    // comes from the panic and not from the parent-death watcher.
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(&request("/dev/fd/3", "secret dictated words"))
        .unwrap();
    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .unwrap();
    let output = child.wait_with_output().expect("wait worker");
    drop(stdin);

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(stderr, "voxloom-cleanup-worker: internal error\n");
    assert!(!stderr.contains("secret"));
    assert!(
        stdout.is_empty(),
        "no reply frame after a panic: {stdout:?}"
    );
    // Rust's exit status for a panic on the main thread.
    assert_eq!(output.status.code(), Some(101));
}
