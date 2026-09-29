use std::collections::VecDeque;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::protocol::WorkerRequest;
use super::worker_process::{ProcessError, ProcessHandle, WorkerProcess};

const WORKER_TIMEOUT: Duration = Duration::from_secs(30);
const CANCELLED_REQUEST_LIMIT: usize = 16;

#[derive(Clone)]
struct ActiveWorker {
    process: ProcessHandle,
    request_id: String,
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
    active: Mutex<Option<ActiveWorker>>,
    cancelled: Mutex<VecDeque<String>>,
    timeout: Duration,
    worker_path: PathBuf,
}

impl WorkerSupervisor {
    pub fn new(worker_path: PathBuf) -> Self {
        Self::with_timeout(worker_path, WORKER_TIMEOUT)
    }

    fn with_timeout(worker_path: PathBuf, timeout: Duration) -> Self {
        Self {
            active: Mutex::new(None),
            cancelled: Mutex::new(VecDeque::new()),
            timeout,
            worker_path,
        }
    }

    pub fn available(&self) -> bool {
        self.worker_path.is_file()
    }

    pub fn run(
        &self,
        model: &File,
        prompt: String,
        request_id: String,
    ) -> Result<String, SupervisorError> {
        if self.take_cancelled(&request_id) {
            return Err(Self::cancelled_error());
        }
        if !self.available() {
            return Err(SupervisorError::runtime(
                "cleanup worker is not installed in this build",
            ));
        }
        let process = WorkerProcess::spawn(&self.worker_path, model)
            .map_err(SupervisorError::runtime)?;
        let active = ActiveWorker {
            process: process.handle.clone(),
            request_id: request_id.clone(),
        };
        {
            let mut slot = self.active.lock().unwrap();
            if slot.is_some() {
                active.process.finish();
                return Err(SupervisorError::runtime(
                    "cleanup worker is already processing",
                ));
            }
            *slot = Some(active.clone());
        }

        let deadline = Instant::now() + self.timeout;
        if self.take_cancelled(&request_id) {
            active.process.cancel();
            active.process.finish();
            self.clear(&request_id);
            return Err(Self::cancelled_error());
        }
        let request = WorkerRequest {
            model_path: "/dev/fd/3".into(),
            prompt,
            request_id: request_id.clone(),
        };
        let response = process.exchange(request, deadline);
        active.process.finish();
        self.clear(&request_id);
        if active.process.cancelled() {
            return Err(Self::cancelled_error());
        }
        let response = match response {
            Ok(response) => response,
            Err(ProcessError::Runtime(error)) => {
                return Err(SupervisorError::runtime(error));
            }
            Err(ProcessError::Timeout) => return Err(Self::timeout_error()),
        };
        if response.request_id != request_id {
            return Err(SupervisorError::runtime(
                "cleanup worker response request ID mismatch",
            ));
        }
        if response.status != "ok" {
            return Err(SupervisorError {
                code: match response.error_code.as_deref() {
                    Some("context-overflow") => "context-overflow",
                    _ => "runtime-error",
                },
                message: response.error.unwrap_or_else(|| {
                    "cleanup worker returned an unknown error".into()
                }),
            });
        }
        response.text.ok_or_else(|| {
            SupervisorError::runtime("cleanup worker returned no text")
        })
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        let active = self.active.lock().unwrap().clone();
        if let Some(worker) = active {
            if worker.request_id == request_id {
                worker.process.cancel();
                worker.process.finish();
                self.clear(request_id);
                return true;
            }
        }
        let mut cancelled = self.cancelled.lock().unwrap();
        if !cancelled.iter().any(|item| item == request_id) {
            if cancelled.len() == CANCELLED_REQUEST_LIMIT {
                cancelled.pop_front();
            }
            cancelled.push_back(request_id.to_owned());
        }
        true
    }

    fn cancelled_error() -> SupervisorError {
        SupervisorError {
            code: "cancelled",
            message: "cleanup request was cancelled".into(),
        }
    }

    fn clear(&self, request_id: &str) {
        let mut active = self.active.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|item| item.request_id == request_id)
        {
            *active = None;
        }
    }

    fn take_cancelled(&self, request_id: &str) -> bool {
        let mut cancelled = self.cancelled.lock().unwrap();
        let Some(index) = cancelled.iter().position(|item| item == request_id)
        else {
            return false;
        };
        cancelled.remove(index);
        true
    }

    fn timeout_error() -> SupervisorError {
        SupervisorError {
            code: "timeout",
            message: "cleanup worker timed out after 30 seconds".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use std::thread;

    fn fake_worker(name: &str, body: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "voxloom-supervisor-{}-{name}",
            std::process::id(),
        ));
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
        fake_worker(name, &format!(r#"{FRAMING}
request = read()
with open(request["modelPath"], "rb") as model:
    assert model.read() == b"GGUFtest"
write({{"error": None, "errorCode": None, "requestId": request["requestId"],
       "status": "ok", "text": "cleaned"}})
"#))
    }

    #[test]
    fn framed_success_and_recovery_after_malformed_output() {
        let model = model_file("success");
        let success = WorkerSupervisor::with_timeout(
            success_worker("success"),
            Duration::from_secs(2),
        );
        assert_eq!(success.run(&model, "p".into(), "r1".into()).unwrap(),
            "cleaned");

        let malformed_path = fake_worker("malformed", &[
            FRAMING,
            "\nread()\n",
            "sys.stdout.buffer.write(b'\\x00\\x00\\x00\\x02xx')",
        ].concat());
        let malformed = WorkerSupervisor::with_timeout(
            malformed_path,
            Duration::from_secs(2),
        );
        assert!(malformed.run(&model, "p".into(), "bad".into()).is_err());
        assert!(malformed.run(&model, "p".into(), "again".into()).is_err());
    }

    #[test]
    fn hung_stdin_is_timed_out_reaped_and_next_run_succeeds() {
        let hung = fake_worker(
            "hung-stdin",
            "import time\ntime.sleep(60)",
        );
        let supervisor = WorkerSupervisor::with_timeout(
            hung,
            Duration::from_millis(100),
        );
        let error = supervisor.run(
            &model_file("hung"),
            "x".repeat(super::super::protocol::MAX_FRAME_BYTES - 256),
            "hung".into(),
        ).unwrap_err();
        assert_eq!(error.code, "timeout");

        let supervisor = WorkerSupervisor::with_timeout(
            success_worker("after-hung"),
            Duration::from_secs(2),
        );
        assert!(supervisor.run(
            &model_file("next"), "p".into(), "next".into(),
        ).is_ok());
    }

    #[test]
    fn active_cancel_and_repeated_cancel_do_not_deadlock() {
        let sleeper = fake_worker("cancel", &format!(r#"{FRAMING}
import time
request = read()
if request["requestId"] == "active":
    time.sleep(60)
write({{"error": None, "errorCode": None,
       "requestId": request["requestId"], "status": "ok", "text": "next"}})
"#));
        let supervisor = Arc::new(WorkerSupervisor::with_timeout(
            sleeper,
            Duration::from_secs(5),
        ));
        let running = Arc::clone(&supervisor);
        let handle = thread::spawn(move || running.run(
            &model_file("active"), "p".into(), "active".into(),
        ));
        for _ in 0..100 {
            if supervisor.active.lock().unwrap().is_some() {
                break;
            }
            thread::yield_now();
        }
        assert!(supervisor.cancel("queued"));
        assert!(supervisor.cancel("active"));
        assert!(supervisor.cancel("active"));
        assert_eq!(supervisor.run(
            &model_file("after-cancel"), "p".into(), "next".into(),
        ).unwrap(), "next");
        let error = handle.join().unwrap().unwrap_err();
        assert_eq!(error.code, "cancelled");
        let queued = supervisor.run(
            &model_file("queued"), "p".into(), "queued".into(),
        ).unwrap_err();
        assert_eq!(queued.code, "cancelled");
    }

    #[test]
    fn late_timed_out_output_cannot_poison_the_next_request() {
        let worker = fake_worker("late", &format!(r#"{FRAMING}
import time
request = read()
if request["requestId"] == "late":
    time.sleep(1)
write({{"error": None, "errorCode": None,
       "requestId": request["requestId"], "status": "ok", "text": "cleaned"}})
"#));
        let supervisor = WorkerSupervisor::with_timeout(
            worker,
            Duration::from_millis(500),
        );
        let late = supervisor.run(
            &model_file("late"), "p".into(), "late".into(),
        ).unwrap_err();
        assert_eq!(late.code, "timeout");
        assert_eq!(supervisor.run(
            &model_file("after-late"), "p".into(), "next".into(),
        ).unwrap(), "cleaned");
    }

    #[test]
    fn mismatched_output_and_crash_are_recoverable() {
        let mismatch = fake_worker("mismatch", &format!(r#"{FRAMING}
read()
write({{"error": None, "errorCode": None, "requestId": "other",
       "status": "ok", "text": "late"}})
"#));
        let supervisor = WorkerSupervisor::with_timeout(
            mismatch,
            Duration::from_secs(2),
        );
        assert!(supervisor.run(
            &model_file("mismatch"), "p".into(), "expected".into(),
        ).unwrap_err().message.contains("mismatch"));

        let crash = WorkerSupervisor::with_timeout(
            fake_worker("crash", "raise RuntimeError('boom')"),
            Duration::from_secs(2),
        );
        assert!(crash.run(
            &model_file("crash"), "p".into(), "crash".into(),
        ).is_err());
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
