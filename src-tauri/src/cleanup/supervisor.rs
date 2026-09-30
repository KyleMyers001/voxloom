use std::collections::VecDeque;
use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::protocol::{encode_frame, WorkerRequest};
use super::worker_process::{ProcessError, ProcessHandle, WorkerProcess};

const WORKER_TIMEOUT: Duration = Duration::from_secs(30);
const CANCELLED_REQUEST_LIMIT: usize = 16;

struct ActiveWorker {
    process: Option<ProcessHandle>,
    request_id: String,
    cancelled: bool,
}

#[derive(Default)]
struct SupervisorState {
    active: Option<ActiveWorker>,
    cancelled: VecDeque<String>,
}

#[derive(Default)]
struct SharedState {
    state: Mutex<SupervisorState>,
    settled: Condvar,
}

#[derive(Debug)]
pub struct SupervisorError {
    pub code: &'static str,
    pub message: String,
}

impl SupervisorError {
    fn runtime(message: impl Into<String>) -> Self {
        Self {
            code: "runtime-error",
            message: message.into(),
        }
    }
}

pub struct WorkerSupervisor {
    shared: Arc<SharedState>,
    timeout: Duration,
    worker_path: PathBuf,
}

impl WorkerSupervisor {
    pub fn new(worker_path: PathBuf) -> Self {
        Self::with_timeout(worker_path, WORKER_TIMEOUT)
    }

    fn with_timeout(worker_path: PathBuf, timeout: Duration) -> Self {
        Self {
            shared: Arc::new(SharedState::default()),
            timeout,
            worker_path,
        }
    }

    pub fn available(&self) -> bool {
        Self::path_available(&self.worker_path)
    }

    fn path_available(path: &std::path::Path) -> bool {
        let Ok(metadata) = path.metadata() else {
            return false;
        };
        if !metadata.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        false
    }

    pub fn reserve(
        &self,
        request_id: String,
    ) -> Result<WorkerReservation, SupervisorError> {
        let mut state = self.shared.state.lock().unwrap();
        if let Some(index) =
            state.cancelled.iter().position(|id| id == &request_id)
        {
            state.cancelled.remove(index);
            return Err(Self::cancelled_error());
        }
        if state.active.is_some() {
            return Err(SupervisorError::runtime(
                "cleanup worker is already processing",
            ));
        }
        state.active = Some(ActiveWorker {
            process: None,
            cancelled: false,
            request_id: request_id.clone(),
        });
        Ok(WorkerReservation {
            shared: Arc::clone(&self.shared),
            request_id,
            started: false,
            timeout: self.timeout,
            worker_path: self.worker_path.clone(),
        })
    }

    #[cfg(test)]
    pub fn run(
        &self,
        model: &File,
        prompt: String,
        request_id: String,
    ) -> Result<String, SupervisorError> {
        self.run_with_spawn(prompt, request_id, || {
            WorkerProcess::spawn(&self.worker_path, model)
        })
    }

    #[cfg(test)]
    fn run_with_spawn(
        &self,
        prompt: String,
        request_id: String,
        spawn: impl FnOnce() -> Result<WorkerProcess, String>,
    ) -> Result<String, SupervisorError> {
        self.reserve(request_id)?.run_with_spawn(prompt, spawn)
    }

    /// Marks cancellation without doing process I/O; safe under the registry
    /// lock. The caller must subsequently cancel/reap outside that lock.
    pub(super) fn mark_cancelled(
        &self,
        request_id: &str,
    ) -> Option<ProcessHandle> {
        let mut state = self.shared.state.lock().unwrap();
        if let Some(active) =
            state.active.as_mut().filter(|a| a.request_id == request_id)
        {
            active.cancelled = true;
            active.process.clone()
        } else {
            if !state.cancelled.iter().any(|id| id == request_id) {
                if state.cancelled.len() == CANCELLED_REQUEST_LIMIT {
                    state.cancelled.pop_front();
                }
                state.cancelled.push_back(request_id.to_owned());
            }
            None
        }
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        let process = self.mark_cancelled(request_id);
        // Never wait on a process under the admission/state lock. Only the
        // reservation's owner can clear the slot, after finishing and reaping.
        if let Some(process) = process {
            process.cancel();
            process.finish();
        }
        true
    }

    pub fn wait_for_settlement(&self, request_id: &str) {
        let mut state = self.shared.state.lock().unwrap();
        while state
            .active
            .as_ref()
            .is_some_and(|a| a.request_id == request_id)
        {
            state = self.shared.settled.wait(state).unwrap();
        }
    }

    pub fn release(&self, request_id: &str) {
        let mut state = self.shared.state.lock().unwrap();
        state.cancelled.retain(|id| id != request_id);
    }

    fn cancelled_error() -> SupervisorError {
        SupervisorError {
            code: "cancelled",
            message: "cleanup request was cancelled".into(),
        }
    }
}

/// Reserves the native slot before verification/spawn. Cancellation is sticky
/// throughout reserved/starting/running; dropping is the sole settlement path.
pub struct WorkerReservation {
    shared: Arc<SharedState>,
    request_id: String,
    started: bool,
    timeout: Duration,
    worker_path: PathBuf,
}

impl WorkerReservation {
    pub fn cancelled(&self) -> bool {
        self.shared
            .state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .cancelled
    }

    pub fn run(
        &mut self,
        model: &File,
        prompt: String,
        on_started: impl FnOnce(),
    ) -> Result<String, SupervisorError> {
        let path = self.worker_path.clone();
        self.run_with_spawn_and_started(
            prompt,
            || WorkerProcess::spawn(&path, model),
            on_started,
        )
    }

    #[cfg(test)]
    fn run_with_spawn(
        &mut self,
        prompt: String,
        spawn: impl FnOnce() -> Result<WorkerProcess, String>,
    ) -> Result<String, SupervisorError> {
        self.run_with_spawn_and_started(prompt, spawn, || {})
    }

    fn run_with_spawn_and_started(
        &mut self,
        prompt: String,
        spawn: impl FnOnce() -> Result<WorkerProcess, String>,
        on_started: impl FnOnce(),
    ) -> Result<String, SupervisorError> {
        if self.cancelled() {
            return Err(WorkerSupervisor::cancelled_error());
        }
        if self.started {
            return Err(SupervisorError::runtime(
                "cleanup reservation already started",
            ));
        }
        self.started = true;
        let request_id = self.request_id.clone();
        let frame = encode_frame(&WorkerRequest {
            model_path: "/dev/fd/3".into(),
            prompt,
            request_id: request_id.clone(),
        })
        .map_err(|_| SupervisorError {
            code: "context-overflow",
            message: "cleanup serialized request exceeds 128 KiB".into(),
        })?;
        if !WorkerSupervisor::path_available(&self.worker_path) {
            return Err(SupervisorError::runtime(
                "cleanup worker is not installed or not executable in this build",
            ));
        }
        let process = spawn().map_err(SupervisorError::runtime)?;
        let handle = process.handle.clone();
        let cancelled = {
            let mut state = self.shared.state.lock().unwrap();
            let active = state.active.as_mut().unwrap();
            active.process = Some(handle.clone());
            active.cancelled
        };
        // An actual child received the verified descriptor. Notify outside
        // locks, even if cancellation raced spawn: this is attempt evidence.
        on_started();
        if cancelled {
            handle.cancel();
            return Err(WorkerSupervisor::cancelled_error());
        }
        let deadline = Instant::now() + self.timeout;
        let response = process.exchange(frame, deadline);
        handle.finish();
        if self.cancelled() || handle.cancelled() {
            return Err(WorkerSupervisor::cancelled_error());
        }
        let response = match response {
            Ok(response) => response,
            Err(ProcessError::Runtime(error)) => {
                return Err(SupervisorError::runtime(error));
            }
            Err(ProcessError::Timeout) => {
                return Err(SupervisorError {
                    code: "timeout",
                    message: format!(
                        "cleanup worker timed out after {} seconds",
                        self.timeout.as_secs_f64()
                    ),
                })
            }
        };
        if response.request_id != request_id
            && !(response.status == "error" && response.request_id.is_empty())
        {
            return Err(SupervisorError::runtime(
                "cleanup worker response request ID mismatch",
            ));
        }
        if response.status == "error" {
            let (Some(code), Some(message)) =
                (response.error_code, response.error)
            else {
                return Err(SupervisorError::runtime(
                    "malformed cleanup worker error",
                ));
            };
            if response.text.is_some()
                || code.is_empty()
                || code.len() > 64
                || message.is_empty()
                || message.len() > 1024
            {
                return Err(SupervisorError::runtime(
                    "invalid cleanup worker error bounds",
                ));
            }
            return Err(SupervisorError {
                code: match code.as_str() {
                    "context-overflow" => "context-overflow",
                    "model-missing" => "model-missing",
                    "invalid-output" => "invalid-output",
                    _ => "runtime-error",
                },
                message,
            });
        }
        if response.status != "ok"
            || response.error.is_some()
            || response.error_code.is_some()
        {
            return Err(SupervisorError::runtime(
                "malformed cleanup worker response",
            ));
        }
        let text = response.text.ok_or_else(|| {
            SupervisorError::runtime("cleanup worker returned no text")
        })?;
        if text.len() > 32_000 {
            return Err(SupervisorError {
                code: "invalid-output",
                message: "cleanup output exceeds 32000 UTF-8 bytes".into(),
            });
        }
        Ok(text)
    }

    pub fn finish(&self) {
        let process = self
            .shared
            .state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .and_then(|active| active.process.clone());
        if let Some(process) = process {
            process.finish();
        }
    }
}

impl Drop for WorkerReservation {
    fn drop(&mut self) {
        self.finish();
        let mut state = self.shared.state.lock().unwrap();
        state.active = None;
        self.shared.settled.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use std::thread;

    fn fake_root(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("voxloom-supervisor-{}-{name}", std::process::id(),))
    }

    fn fake_worker(name: &str, body: &str) -> PathBuf {
        let root = fake_root(name);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("worker.py");
        fs::write(&path, format!("#!/usr/bin/env python3\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn model_file(name: &str) -> File {
        let path = std::env::temp_dir().join(format!(
            "voxloom-supervisor-model-{}-{name}",
            std::process::id(),
        ));
        fs::write(&path, b"GGUFtest").unwrap();
        File::open(path).unwrap()
    }

    const FRAMING: &str = r#"
import json, struct, sys
def read():
    size = struct.unpack('>I', sys.stdin.buffer.read(4))[0]
    return json.loads(sys.stdin.buffer.read(size))
def write(value):
    data = json.dumps(value).encode()
    sys.stdout.buffer.write(struct.pack('>I', len(data)) + data)
    sys.stdout.buffer.flush()
"#;

    fn success_worker(name: &str) -> PathBuf {
        fake_worker(
            name,
            &format!(
                r#"{FRAMING}
request = read()
with open(request["modelPath"], "rb") as model:
    assert model.read() == b"GGUFtest"
write({{"error": None, "errorCode": None, "requestId": request["requestId"],
       "status": "ok", "text": "cleaned"}})
"#
            ),
        )
    }

    #[test]
    fn cancelled_reservation_keeps_the_slot_until_its_owner_settles() {
        let supervisor =
            WorkerSupervisor::new(success_worker("reserved-cancel"));
        let reservation = supervisor.reserve("reserved".into()).unwrap();
        supervisor.cancel("reserved");
        supervisor.release("reserved");
        assert!(reservation.cancelled());
        assert!(supervisor.reserve("too-early".into()).is_err());
        drop(reservation);
        assert!(supervisor.reserve("after-settlement".into()).is_ok());
    }

    #[test]
    fn overlap_is_rejected_before_either_spawn_completes() {
        let path = success_worker("overlap-before-spawn");
        let supervisor = Arc::new(WorkerSupervisor::new(path.clone()));
        let (entered, wait_entered) = std::sync::mpsc::channel();
        let (proceed, wait_proceed) = std::sync::mpsc::channel();
        let first = Arc::clone(&supervisor);
        let first_path = path.clone();
        let running = thread::spawn(move || {
            first.run_with_spawn("p".into(), "first".into(), || {
                entered.send(()).unwrap();
                wait_proceed.recv().unwrap();
                WorkerProcess::spawn(&first_path, &model_file("overlap-a"))
            })
        });
        wait_entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let spawned = std::sync::atomic::AtomicBool::new(false);
        let second =
            supervisor.run_with_spawn("p".into(), "second".into(), || {
                spawned.store(true, std::sync::atomic::Ordering::SeqCst);
                WorkerProcess::spawn(&path, &model_file("overlap-b"))
            });
        proceed.send(()).unwrap();
        assert_eq!(running.join().unwrap().unwrap(), "cleaned");
        assert!(!spawned.load(std::sync::atomic::Ordering::SeqCst));
        assert!(second.unwrap_err().message.contains("already processing"));
    }

    #[test]
    fn release_cannot_erase_a_cancel_during_spawn() {
        let path = success_worker("cancel-during-spawn");
        let supervisor = Arc::new(WorkerSupervisor::new(path.clone()));
        let (entered, wait_entered) = std::sync::mpsc::channel();
        let (proceed, wait_proceed) = std::sync::mpsc::channel();
        let first = Arc::clone(&supervisor);
        let running = thread::spawn(move || {
            first.run_with_spawn("p".into(), "starting".into(), || {
                entered.send(()).unwrap();
                wait_proceed.recv().unwrap();
                WorkerProcess::spawn(&path, &model_file("spawn-cancel"))
            })
        });
        wait_entered.recv_timeout(Duration::from_secs(5)).unwrap();
        supervisor.cancel("starting");
        supervisor.release("starting");
        proceed.send(()).unwrap();
        assert_eq!(running.join().unwrap().unwrap_err().code, "cancelled");
        assert_eq!(
            supervisor
                .run(
                    &model_file("spawn-cancel-next"),
                    "p".into(),
                    "next".into(),
                )
                .unwrap(),
            "cleaned"
        );
    }

    #[test]
    fn framed_success_and_recovery_after_malformed_output() {
        let model = model_file("success");
        let success = WorkerSupervisor::with_timeout(
            success_worker("success"),
            Duration::from_secs(2),
        );
        assert_eq!(
            success.run(&model, "p".into(), "r1".into()).unwrap(),
            "cleaned"
        );

        let malformed_marker = fake_root("malformed").join("failed-once");
        let malformed_path = fake_worker(
            "malformed",
            &format!(
                r#"{FRAMING}
from pathlib import Path
request = read()
marker = Path(r"{}")
if not marker.exists():
    marker.touch()
    sys.stdout.buffer.write(b'\x00\x00\x00\x02xx')
else:
    write({{"error": None, "errorCode": None,
           "requestId": request["requestId"], "status": "ok",
           "text": "recovered"}})
"#,
                malformed_marker.display()
            ),
        );
        let malformed = WorkerSupervisor::with_timeout(
            malformed_path,
            Duration::from_secs(2),
        );
        assert!(malformed.run(&model, "p".into(), "bad".into()).is_err());
        assert_eq!(
            malformed.run(&model, "p".into(), "again".into(),).unwrap(),
            "recovered"
        );
    }

    #[test]
    fn hung_stdin_is_timed_out_reaped_and_next_run_succeeds() {
        let hung = fake_worker("hung-stdin", "import time\ntime.sleep(60)");
        let supervisor =
            WorkerSupervisor::with_timeout(hung, Duration::from_millis(100));
        let error = supervisor
            .run(
                &model_file("hung"),
                "x".repeat(super::super::protocol::MAX_FRAME_BYTES - 256),
                "hung".into(),
            )
            .unwrap_err();
        assert_eq!(error.code, "timeout");

        let supervisor = WorkerSupervisor::with_timeout(
            success_worker("after-hung"),
            Duration::from_secs(2),
        );
        assert!(supervisor
            .run(&model_file("next"), "p".into(), "next".into(),)
            .is_ok());
    }

    #[test]
    fn active_cancel_and_repeated_cancel_do_not_deadlock() {
        let sleeper = fake_worker(
            "cancel",
            &format!(
                r#"{FRAMING}
import time
request = read()
if request["requestId"] == "active":
    time.sleep(60)
write({{"error": None, "errorCode": None,
       "requestId": request["requestId"], "status": "ok", "text": "next"}})
"#
            ),
        );
        let supervisor = Arc::new(WorkerSupervisor::with_timeout(
            sleeper,
            Duration::from_secs(5),
        ));
        let running = Arc::clone(&supervisor);
        let handle = thread::spawn(move || {
            running.run(&model_file("active"), "p".into(), "active".into())
        });
        for _ in 0..100 {
            if supervisor.shared.state.lock().unwrap().active.is_some() {
                break;
            }
            thread::yield_now();
        }
        assert!(supervisor.cancel("queued"));
        assert!(supervisor.cancel("active"));
        assert!(supervisor.cancel("active"));
        let error = handle.join().unwrap().unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert_eq!(
            supervisor
                .run(&model_file("after-cancel"), "p".into(), "next".into(),)
                .unwrap(),
            "next"
        );
        let queued = supervisor
            .run(&model_file("queued"), "p".into(), "queued".into())
            .unwrap_err();
        assert_eq!(queued.code, "cancelled");
    }

    #[test]
    fn late_timed_out_output_cannot_poison_the_next_request() {
        let worker = fake_worker(
            "late",
            &format!(
                r#"{FRAMING}
import time
request = read()
if request["requestId"] == "late":
    time.sleep(60)
write({{"error": None, "errorCode": None,
       "requestId": request["requestId"], "status": "ok", "text": "cleaned"}})
"#
            ),
        );
        let supervisor = WorkerSupervisor::with_timeout(
            worker,
            // Permit normal parallel Python startup on the recovery request;
            // the timeout path deliberately stalls far beyond this deadline.
            Duration::from_secs(3),
        );
        let late = supervisor
            .run(&model_file("late"), "p".into(), "late".into())
            .unwrap_err();
        assert_eq!(late.code, "timeout");
        assert!(late.message.contains("3 seconds"));
        assert_eq!(
            supervisor
                .run(&model_file("after-late"), "p".into(), "next".into(),)
                .unwrap(),
            "cleaned"
        );
    }

    #[test]
    fn mismatched_output_and_crash_are_recoverable() {
        let mismatch = fake_worker(
            "mismatch",
            &format!(
                r#"{FRAMING}
read()
write({{"error": None, "errorCode": None, "requestId": "other",
       "status": "ok", "text": "late"}})
"#
            ),
        );
        let supervisor =
            WorkerSupervisor::with_timeout(mismatch, Duration::from_secs(2));
        assert!(supervisor
            .run(&model_file("mismatch"), "p".into(), "expected".into(),)
            .unwrap_err()
            .message
            .contains("mismatch"));

        let crash_marker = fake_root("crash").join("failed-once");
        let crash_worker = fake_worker(
            "crash",
            &format!(
                r#"{FRAMING}
from pathlib import Path
request = read()
marker = Path(r"{}")
if not marker.exists():
    marker.touch()
    sys.exit(1)
write({{"error": None, "errorCode": None,
       "requestId": request["requestId"], "status": "ok",
       "text": "recovered"}})
"#,
                crash_marker.display()
            ),
        );
        let crash = WorkerSupervisor::with_timeout(
            crash_worker,
            Duration::from_secs(2),
        );
        assert!(crash
            .run(&model_file("crash"), "p".into(), "crash".into(),)
            .is_err());
        assert_eq!(
            crash
                .run(&model_file("after-crash"), "p".into(), "next".into(),)
                .unwrap(),
            "recovered"
        );
    }

    #[test]
    fn released_prestart_cancel_does_not_poison_reused_request_id() {
        let supervisor = WorkerSupervisor::with_timeout(
            success_worker("released-cancel"),
            Duration::from_secs(2),
        );
        assert!(supervisor.cancel("remount-request"));
        supervisor.release("remount-request");
        assert_eq!(
            supervisor
                .run(
                    &model_file("released-cancel"),
                    "p".into(),
                    "remount-request".into(),
                )
                .unwrap(),
            "cleaned"
        );
    }

    #[test]
    fn serialized_oversize_is_rejected_before_spawn_and_slot_recovers() {
        let supervisor = WorkerSupervisor::new(success_worker("frame-limit"));
        for prompt in [
            "x".repeat(super::super::protocol::MAX_FRAME_BYTES),
            "\0".repeat(super::super::protocol::MAX_FRAME_BYTES / 6),
            "é".repeat(super::super::protocol::MAX_FRAME_BYTES / 2),
            "\\\"".repeat(super::super::protocol::MAX_FRAME_BYTES / 4),
        ] {
            let spawned = std::cell::Cell::new(false);
            let error = supervisor
                .run_with_spawn(prompt, "oversize".into(), || {
                    spawned.set(true);
                    Err("unexpected spawn".into())
                })
                .unwrap_err();
            assert!(!spawned.get(), "oversize must fail before spawning");
            assert_eq!(error.code, "context-overflow");
        }
        assert_eq!(
            supervisor
                .run(&model_file("frame-limit"), "p".into(), "next".into())
                .unwrap(),
            "cleaned"
        );
    }

    #[test]
    fn exact_serialized_frame_limit_is_accepted() {
        let request = WorkerRequest {
            model_path: "/dev/fd/3".into(),
            prompt: String::new(),
            request_id: "r".into(),
        };
        let overhead = serde_json::to_vec(&request).unwrap().len();
        let prompt =
            "x".repeat(super::super::protocol::MAX_FRAME_BYTES - overhead);
        let supervisor = WorkerSupervisor::new(success_worker("frame-exact"));
        assert_eq!(
            supervisor
                .run(&model_file("frame-exact"), prompt, "r".into())
                .unwrap(),
            "cleaned"
        );
    }

    #[test]
    fn startup_error_survives_empty_id_and_broken_stdin() {
        let worker = fake_worker(
            "startup-error",
            &format!(
                r#"{FRAMING}
write({{"error": "model descriptor unavailable", "errorCode": "model-missing",
       "requestId": "", "status": "error", "text": None}})
"#
            ),
        );
        let supervisor = WorkerSupervisor::new(worker);
        // Larger than pipe capacity: child deliberately exits without reading.
        let error = supervisor
            .run(
                &model_file("startup-error"),
                "x".repeat(100_000),
                "r".into(),
            )
            .unwrap_err();
        assert_eq!(error.code, "model-missing");
        assert_eq!(error.message, "model descriptor unavailable");
    }

    #[test]
    fn worker_response_shapes_ids_and_diagnostics_are_bounded() {
        let cases = [
            (
                "empty-success",
                "ok",
                "",
                "None",
                "None",
                "'text'",
                "runtime-error",
            ),
            (
                "wrong-error",
                "error",
                "other",
                "'context-overflow'",
                "'full'",
                "None",
                "runtime-error",
            ),
            (
                "unknown-status",
                "future",
                "r",
                "'context-overflow'",
                "'full'",
                "None",
                "runtime-error",
            ),
            (
                "mixed-error",
                "error",
                "r",
                "'context-overflow'",
                "'full'",
                "'text'",
                "runtime-error",
            ),
            (
                "long-error",
                "error",
                "r",
                "'context-overflow'",
                "'é' * 513",
                "None",
                "runtime-error",
            ),
            (
                "long-code",
                "error",
                "r",
                "'x' * 65",
                "'full'",
                "None",
                "runtime-error",
            ),
            (
                "unknown-code",
                "error",
                "",
                "'future-code'",
                "'diagnostic'",
                "None",
                "runtime-error",
            ),
            (
                "invalid-output",
                "error",
                "r",
                "'invalid-output'",
                "'invalid UTF-8'",
                "None",
                "invalid-output",
            ),
            (
                "long-output",
                "ok",
                "r",
                "None",
                "None",
                "'é' * 16001",
                "invalid-output",
            ),
        ];
        for (name, status, id, code, message, text, expected) in cases {
            let path = fake_worker(
                name,
                &format!(
                    r#"{FRAMING}
read()
write({{"error": {message}, "errorCode": {code}, "requestId": "{id}",
       "status": "{status}", "text": {text}}})
"#
                ),
            );
            let supervisor = WorkerSupervisor::new(path);
            let error = supervisor
                .run(&model_file(name), "p".into(), "r".into())
                .unwrap_err();
            assert_eq!(error.code, expected, "{name}");
            assert!(error.message.len() <= 1024, "{name}");
            if name == "unknown-code" {
                assert_eq!(error.message, "diagnostic");
            }
        }
    }

    #[test]
    fn readiness_requires_an_executable_regular_file() {
        let path =
            fake_worker("readiness", "raise RuntimeError('must not run')");
        let supervisor = WorkerSupervisor::new(path.clone());
        assert!(supervisor.available());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!supervisor.available());
        assert!(!WorkerSupervisor::new(fake_root("readiness")).available());
        let error = supervisor
            .run(&model_file("not-executable"), "p".into(), "r".into())
            .unwrap_err();
        assert_eq!(error.code, "runtime-error");
        assert!(error.message.contains("not executable"));
    }

    #[test]
    fn unavailable_worker_fails_honestly() {
        let supervisor = WorkerSupervisor::new(PathBuf::from("/missing"));
        let error = supervisor
            .run(&model_file("missing"), "prompt".into(), "r1".into())
            .unwrap_err();
        assert!(error.message.contains("not installed"));
    }
}
