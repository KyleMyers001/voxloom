use std::fs::File;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::protocol::{read_frame, write_encoded_frame, WorkerResponse};

#[derive(Clone)]
pub struct ProcessHandle {
    cancelled: Arc<AtomicBool>,
    child: Arc<Mutex<Child>>,
}

pub struct WorkerProcess {
    pub handle: ProcessHandle,
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
}

impl ProcessHandle {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let _ = self.child.lock().unwrap().kill();
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn finish(&self) {
        let mut child = self.child.lock().unwrap();
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

impl WorkerProcess {
    pub fn spawn(worker: &Path, model: &File) -> Result<Self, String> {
        // Relocate before Command wires piped stdio. If stdin/stdout were
        // closed, open(model) can return fd 0/1; those get replaced by the
        // pipes and pre_exec would then dup2 a pipe onto fd 3.
        #[cfg(unix)]
        let model_fd = relocate_above_stdio(model)?;
        let mut command = Command::new(worker);
        // Nothing from the app's environment reaches the worker (BUS-16 3c-1).
        command
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(unix)]
        inherit_model(model_fd.as_raw_fd(), &mut command);
        #[cfg(not(unix))]
        let _ = model;
        let mut child = command
            .spawn()
            .map_err(|error| format!("start cleanup worker: {error}"))?;
        #[cfg(unix)]
        drop(model_fd);
        let stdin = child.stdin.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            "cleanup worker stdin unavailable".to_owned()
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            "cleanup worker stdout unavailable".to_owned()
        })?;
        Ok(Self {
            handle: ProcessHandle {
                cancelled: Arc::new(AtomicBool::new(false)),
                child: Arc::new(Mutex::new(child)),
            },
            stdin,
            stdout,
        })
    }

    pub fn exchange(
        self,
        frame: Vec<u8>,
        deadline: Instant,
    ) -> Result<WorkerResponse, ProcessError> {
        // Read concurrently: a startup error may arrive before stdin is read.
        // Waiting for writes first can hide it behind EPIPE or a full pipe.
        let (read_sender, read_receiver) = mpsc::channel();
        let mut stdout = self.stdout;
        std::thread::spawn(move || {
            let _ = read_sender.send(read_frame::<WorkerResponse>(&mut stdout));
        });
        let (write_sender, write_receiver) = mpsc::channel();
        let mut stdin = self.stdin;
        std::thread::spawn(move || {
            let result = write_encoded_frame(&mut stdin, &frame);
            drop(stdin);
            let _ = write_sender.send(result);
        });
        let response = match read_receiver.recv_timeout(remaining(deadline)) {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return Err(ProcessError::Runtime(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => return Err(ProcessError::Timeout),
            Err(error) => {
                return Err(ProcessError::Runtime(format!(
                    "cleanup worker response failed: {error}",
                )))
            }
        };
        // Only the dedicated error path can bypass completed input. The
        // supervisor still validates status, IDs, fields, and diagnostic bounds.
        if response.status == "error" {
            return Ok(response);
        }
        match write_receiver.recv_timeout(remaining(deadline)) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(ProcessError::Runtime(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(ProcessError::Timeout);
            }
            Err(error) => {
                return Err(ProcessError::Runtime(format!(
                    "cleanup worker input failed: {error}",
                )));
            }
        }

        Ok(response)
    }
}

pub enum ProcessError {
    Runtime(String),
    Timeout,
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

/// Duplicate `model` onto an fd ≥ 3 so Command's piped stdio cannot clobber it.
#[cfg(unix)]
fn relocate_above_stdio(model: &File) -> Result<OwnedFd, String> {
    let source = model.as_raw_fd();
    // SAFETY: F_DUPFD_CLOEXEC only allocates a new descriptor; the caller owns it.
    let duplicated = unsafe { libc::fcntl(source, libc::F_DUPFD_CLOEXEC, 3) };
    if duplicated < 0 {
        return Err(format!(
            "relocate model fd: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: duplicated is an open fd we just allocated and uniquely own.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

#[cfg(unix)]
fn inherit_model(source: RawFd, command: &mut Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: dup2/fcntl are async-signal-safe and this closure performs no
    // allocation between fork and exec. `source` is ≥ 3 (relocated) so stdio
    // pipe setup cannot have replaced it.
    unsafe {
        command.pre_exec(move || {
            if source != 3 && libc::dup2(source, 3) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(3, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(test)]
#[path = "worker_process_tests.rs"]
mod tests;
