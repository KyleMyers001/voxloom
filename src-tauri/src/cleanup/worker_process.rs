use std::fs::File;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::protocol::{read_frame, write_frame, WorkerRequest, WorkerResponse};

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
        let mut command = Command::new(worker);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        inherit_model(model, &mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("start cleanup worker: {error}"))?;
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
        request: WorkerRequest,
        deadline: Instant,
    ) -> Result<WorkerResponse, ProcessError> {
        let (write_sender, write_receiver) = mpsc::channel();
        let mut stdin = self.stdin;
        std::thread::spawn(move || {
            let result = write_frame(&mut stdin, &request);
            drop(stdin);
            let _ = write_sender.send(result);
        });
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

        let (read_sender, read_receiver) = mpsc::channel();
        let mut stdout = self.stdout;
        std::thread::spawn(move || {
            let _ = read_sender.send(read_frame::<WorkerResponse>(&mut stdout));
        });
        match read_receiver.recv_timeout(remaining(deadline)) {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(error)) => Err(ProcessError::Runtime(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ProcessError::Timeout),
            Err(error) => Err(ProcessError::Runtime(format!(
                "cleanup worker response failed: {error}",
            ))),
        }
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
fn inherit_model(model: &File, command: &mut Command) {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;

    let source = model.as_raw_fd();
    // SAFETY: dup2/fcntl are async-signal-safe and this closure performs no
    // allocation between fork and exec.
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

#[cfg(not(unix))]
fn inherit_model(_model: &File, _command: &mut Command) {}
