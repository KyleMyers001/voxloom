//! BUS-16 PR 3c-1 contract test: spawn the real worker binary the way the app
//! does (env cleared, model on fd 3) and check the protocol replies. Runs on
//! Linux CPU builds; the happy path needs a real Qwen3 GGUF (ignored test).

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

const WORKER: &str = env!("CARGO_BIN_EXE_voxloom-cleanup-worker");

struct Reply {
    frame: Value,
    stderr: Vec<u8>,
}

/// Run the worker with `input` on stdin and, if given, `model` on fd 3.
fn run(input: &[u8], model: Option<&File>) -> Reply {
    let mut command = Command::new(WORKER);
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let source = model.map(AsRawFd::as_raw_fd);
    // SAFETY: dup2/fcntl/close only, between fork and exec.
    unsafe {
        command.pre_exec(move || {
            // No model: make sure nothing inherited (e.g. a jobserver pipe)
            // sits on fd 3.
            let Some(source) = source else {
                libc::close(3);
                return Ok(());
            };
            if source != 3 && libc::dup2(source, 3) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(3, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().expect("spawn worker");
    let mut stdin = child.stdin.take().unwrap();
    // The worker may answer before reading everything; ignore EPIPE.
    let _ = stdin.write_all(input);
    drop(stdin);
    let output = child.wait_with_output().expect("wait worker");
    Reply {
        frame: decode(&output.stdout),
        stderr: output.stderr,
    }
}

fn decode(stdout: &[u8]) -> Value {
    assert!(stdout.len() > 4, "no reply frame: {stdout:?}");
    let size = u32::from_be_bytes(stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(stdout.len(), 4 + size, "exactly one frame");
    serde_json::from_slice(&stdout[4..]).expect("reply JSON")
}

fn frame(value: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).unwrap();
    let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
    bytes.extend(body);
    bytes
}

fn request(model_path: &str, prompt: &str) -> Vec<u8> {
    frame(&json!({ "modelPath": model_path, "prompt": prompt, "requestId": "r-7" }))
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
    assert_error(&run(&[0, 0, 0, 9, b'{'], None), "runtime-error", "");
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
