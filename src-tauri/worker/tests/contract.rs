//! BUS-16 PR 3c-1 contract test: spawn the real worker binary the way the app
//! does (env cleared, model on fd 3) and check the protocol replies. Runs on
//! Linux CPU builds; the happy path needs a real Qwen3 GGUF (ignored test).

mod common;

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::Value;

use common::{request, worker_command, WORKER};

struct Reply {
    frame: Value,
    stderr: Vec<u8>,
}

/// Run the worker with `input` on stdin and, if given, `model` on fd 3.
/// Like the app, stdin stays open until the reply is in (BUS-16 3c-2).
fn run(input: &[u8], model: Option<&File>) -> Reply {
    run_stdin(input, model, false)
}

/// `close_stdin`: end stdin right after `input`, for frames that are cut
/// short and would otherwise wait for the rest.
fn run_stdin(input: &[u8], model: Option<&File>, close_stdin: bool) -> Reply {
    let mut child = worker_command(model.map(AsRawFd::as_raw_fd))
        .stdin(Stdio::piped())
        .spawn()
        .expect("spawn worker");
    let mut stdin = child.stdin.take().unwrap();
    // The worker may answer before reading everything; ignore EPIPE.
    let _ = stdin.write_all(input);
    if close_stdin {
        drop(stdin);
        let output = child.wait_with_output().expect("wait worker");
        return Reply {
            frame: decode(&output.stdout),
            stderr: output.stderr,
        };
    }
    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .unwrap();
    drop(stdin);
    let output = child.wait_with_output().expect("wait worker");
    Reply {
        frame: decode(&stdout),
        stderr: output.stderr,
    }
}

fn decode(stdout: &[u8]) -> Value {
    assert!(stdout.len() > 4, "no reply frame: {stdout:?}");
    let size = u32::from_be_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(stdout.len(), 4 + size, "exactly one frame");
    serde_json::from_slice(&stdout[4..]).expect("reply JSON")
}

fn assert_error(reply: &Reply, code: &str, request_id: &str) {
    assert_eq!(reply.frame["status"], "error", "{}", reply.frame);
    assert_eq!(reply.frame["errorCode"], code, "{}", reply.frame);
    assert_eq!(reply.frame["requestId"], request_id);
    assert!(reply.frame["text"].is_null());
    assert!(!reply.frame["error"].as_str().unwrap().is_empty());
    assert!(
        reply.stderr.is_empty(),
        "stderr: {:?}",
        String::from_utf8_lossy(&reply.stderr)
    );
}

fn scratch(name: &str, bytes: &[u8]) -> File {
    let dir = std::env::temp_dir().join(format!("vx-worker-contract-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    File::open(path).unwrap()
}

#[test]
fn zero_length_frame_gets_an_error_frame() {
    assert_error(&run(&0_u32.to_be_bytes(), None), "runtime-error", "");
}

#[test]
fn oversized_frame_header_gets_an_error_frame() {
    assert_error(
        &run(&(128 * 1024 + 1_u32).to_be_bytes(), None),
        "runtime-error",
        "",
    );
}

#[test]
fn truncated_or_non_json_frame_gets_an_error_frame() {
    let truncated = run_stdin(&[0, 0, 0, 9, b'{'], None, true);
    assert_error(&truncated, "runtime-error", "");
    let mut bad = 5_u32.to_be_bytes().to_vec();
    bad.extend(b"hello");
    assert_error(&run(&bad, None), "runtime-error", "");
}

#[test]
fn missing_model_on_fd_three_is_model_missing() {
    assert_error(
        &run(&request("/dev/fd/3", "secret words"), None),
        "model-missing",
        "r-7",
    );
}

#[test]
fn a_non_gguf_model_on_fd_three_is_model_missing() {
    let model = scratch("bad.gguf", b"GGUFnot really a model");
    assert_error(
        &run(&request("/dev/fd/3", "secret words"), Some(&model)),
        "model-missing",
        "r-7",
    );
}

#[test]
fn a_model_path_other_than_fd_three_is_refused() {
    let model = scratch("other.gguf", b"GGUF");
    let reply = run(&request("/tmp/model.gguf", "secret words"), Some(&model));
    assert_error(&reply, "runtime-error", "r-7");
}

#[test]
fn an_empty_prompt_is_refused() {
    assert_error(
        &run(&request("/dev/fd/3", "  "), None),
        "runtime-error",
        "r-7",
    );
}

#[test]
fn error_messages_never_quote_the_request() {
    let reply = run(&request("/dev/fd/3", "secret words"), None);
    assert!(!reply.frame.to_string().contains("secret"));
}

/// Needs a real Qwen3 GGUF (e.g. the default 1.7B):
/// `VOXLOOM_TEST_CLEANUP_MODEL=/path/model.gguf cargo test -- --ignored`
#[test]
#[ignore = "needs a real Qwen3 GGUF in VOXLOOM_TEST_CLEANUP_MODEL"]
fn a_real_model_cleans_text() {
    let path = PathBuf::from(std::env::var("VOXLOOM_TEST_CLEANUP_MODEL").expect("model path"));
    let model = File::open(path).unwrap();
    let prompt =
        "Fix punctuation and capitalization. Reply with the text only.\n\nhello there how are you";
    let reply = run(&request("/dev/fd/3", prompt), Some(&model));
    assert_eq!(reply.frame["status"], "ok", "{}", reply.frame);
    assert_eq!(reply.frame["requestId"], "r-7");
    let text = reply.frame["text"].as_str().unwrap();
    assert!(text.to_lowercase().contains("hello"), "{text}");
    assert!(!text.contains("<think>"), "{text}");
    assert!(
        reply.stderr.is_empty(),
        "stderr: {:?}",
        String::from_utf8_lossy(&reply.stderr)
    );
}

#[test]
fn reply_frame_reads_back_through_stdout_only() {
    // Sanity: the binary exists and writes nothing before reading stdin.
    let mut child = Command::new(WORKER)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = Vec::new();
    child.stdout.take().unwrap().read_to_end(&mut out).unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success());
    assert_eq!(decode(&out)["errorCode"], "runtime-error");
}
