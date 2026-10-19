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
        command
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
mod tests {
    #[cfg(unix)]
    #[test]
    fn relocate_puts_model_fd_at_or_above_three() {
        use super::relocate_above_stdio;
        use std::os::fd::AsRawFd;

        let file = tempfile_model("relocate");
        let relocated = relocate_above_stdio(&file).unwrap();
        assert!(
            relocated.as_raw_fd() >= 3,
            "relocated fd must stay above stdio, got {}",
            relocated.as_raw_fd()
        );
    }

    /// The child must see the model on fd 3 via the relocated descriptor.
    #[cfg(unix)]
    #[test]
    fn spawn_passes_relocated_model_on_fd_three() {
        let root = spawn_root("spawn-fd3");
        let model = std::fs::File::open(root.join("model.gguf")).unwrap();
        assert_child_reads_model_on_fd_three(&root, &model);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A model opened while stdin was closed lands on fd 0, which the child's
    /// stdin pipe replaces. Only the relocated descriptor still names the
    /// model, so spawning from the original fd would hand the pipe to fd 3.
    #[cfg(unix)]
    #[test]
    fn spawn_uses_relocated_fd_when_model_sits_on_stdin() {
        use std::fs::File;
        use std::mem::ManuallyDrop;
        use std::os::fd::{AsRawFd, FromRawFd};

        let root = spawn_root("spawn-fd0");
        let model = File::open(root.join("model.gguf")).unwrap();
        // Borrow fd 0 for the spawn, then restore the test process's stdin.
        // Nothing in the test harness reads stdin meanwhile.
        // SAFETY: dup/dup2/close on fds this test owns; fd 0 is wrapped in
        // ManuallyDrop so it is never closed by the File.
        let saved = unsafe { libc::dup(0) };
        assert!(saved >= 0, "save stdin");
        assert_eq!(unsafe { libc::dup2(model.as_raw_fd(), 0) }, 0);
        let on_stdin = ManuallyDrop::new(unsafe { File::from_raw_fd(0) });
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert_child_reads_model_on_fd_three(&root, &on_stdin)
        }));
        unsafe {
            libc::dup2(saved, 0);
            libc::close(saved);
        }
        let _ = std::fs::remove_dir_all(&root);
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    #[cfg(unix)]
    fn spawn_root(label: &str) -> std::path::PathBuf {
        let root = crate::cleanup::test_support::test_root().join(label);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("model.gguf"), b"GGUFtest").unwrap();
        root
    }

    #[cfg(unix)]
    fn assert_child_reads_model_on_fd_three(root: &std::path::Path, model: &std::fs::File) {
        use crate::cleanup::test_support::{wait_until, write_executable};
        use std::time::Duration;

        let marker = root.join("fd3-bytes");
        let worker = root.join("worker.py");
        write_executable(
            &worker,
            &format!(
                "#!/usr/bin/env python3\nimport os\nopen(r'{0}', 'wb').write(os.read(3, 8))\n",
                marker.display()
            ),
        );
        let process = super::WorkerProcess::spawn(&worker, model).unwrap();
        let seen = wait_until(Duration::from_secs(2), || {
            std::fs::read(&marker).ok().as_deref() == Some(b"GGUFtest".as_slice())
        });
        process.handle.finish();
        assert!(seen, "spawn must inherit the relocated model on fd 3");
    }

    #[cfg(unix)]
    fn tempfile_model(label: &str) -> std::fs::File {
        let path = crate::cleanup::test_support::test_root()
            .join(format!("worker-fd-{label}-{}.gguf", std::process::id()));
        std::fs::write(&path, b"GGUFtest").unwrap();
        std::fs::File::open(path).unwrap()
    }
}
