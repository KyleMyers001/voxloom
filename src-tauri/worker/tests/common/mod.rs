//! Spawning the worker binary the way the app does (BUS-16 3c-1/3c-2):
//! environment cleared, the model descriptor dup2'd onto fd 3.

use std::os::fd::RawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

pub const WORKER: &str = env!("CARGO_BIN_EXE_voxloom-cleanup-worker");

/// The worker command with `model` (if any) on fd 3 and piped stdout and
/// stderr. The caller picks stdin.
pub fn worker_command(model: Option<RawFd>) -> Command {
    let mut command = Command::new(WORKER);
    command
        .env_clear()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: dup2/fcntl/close only, between fork and exec.
    unsafe {
        command.pre_exec(move || {
            // No model: make sure nothing inherited (e.g. a jobserver pipe)
            // sits on fd 3.
            let Some(source) = model else {
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
    command
}

pub fn frame(value: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).unwrap();
    let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
    bytes.extend(body);
    bytes
}

pub fn request(model_path: &str, prompt: &str) -> Vec<u8> {
    frame(&json!({ "modelPath": model_path, "prompt": prompt, "requestId": "r-7" }))
}
