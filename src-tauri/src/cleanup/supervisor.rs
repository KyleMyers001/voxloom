use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::protocol::{read_frame, write_frame, WorkerRequest, WorkerResponse};

const WORKER_TIMEOUT: Duration = Duration::from_secs(30);
const CANCELLED_REQUEST_LIMIT: usize = 16;

struct ActiveWorker {
    child: Arc<Mutex<Child>>,
    request_id: String,
}

pub struct WorkerSupervisor {
    active: Mutex<Option<ActiveWorker>>,
    cancelled: Mutex<VecDeque<String>>,
    worker_path: PathBuf,
}

impl WorkerSupervisor {
    pub fn new(worker_path: PathBuf) -> Self {
        Self {
            active: Mutex::new(None),
            cancelled: Mutex::new(VecDeque::new()),
            worker_path,
        }
    }

    pub fn available(&self) -> bool {
        self.worker_path.is_file()
    }

    pub fn run(
        &self,
        model_path: &Path,
        prompt: String,
        request_id: String,
    ) -> Result<String, String> {
        if self.take_cancelled(&request_id) {
            return Err("cleanup request was cancelled".into());
        }
        if !self.available() {
            return Err("cleanup worker is not installed in this build".into());
        }
        let mut active = self.active.lock().unwrap();
        if active.is_some() {
            return Err("cleanup worker is already processing".into());
        }
        let mut child = Command::new(&self.worker_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("start cleanup worker: {error}"))?;
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cleanup worker stdin unavailable".into());
        };
        let Some(mut stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cleanup worker stdout unavailable".into());
        };
        let request = WorkerRequest {
            model_path: model_path.to_string_lossy().into_owned(),
            prompt,
            request_id: request_id.clone(),
        };
        if let Err(error) = write_frame(&mut stdin, &request) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        drop(stdin);

        let child = Arc::new(Mutex::new(child));
        *active = Some(ActiveWorker {
            child: Arc::clone(&child),
            request_id: request_id.clone(),
        });
        drop(active);
        if self.take_cancelled(&request_id) {
            let mut process = child.lock().unwrap();
            let _ = process.kill();
            let _ = process.wait();
            self.clear(&request_id);
            return Err("cleanup request was cancelled".into());
        }
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(read_frame::<WorkerResponse>(&mut stdout));
        });
        let response = match receiver.recv_timeout(WORKER_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let mut process = child.lock().unwrap();
                let _ = process.kill();
                let _ = process.wait();
                Err("cleanup worker timed out after 30 seconds".into())
            }
            Err(error) => {
                Err(format!("cleanup worker response failed: {error}"))
            }
        };
        {
            let mut process = child.lock().unwrap();
            if process.try_wait().ok().flatten().is_none() {
                let _ = process.kill();
            }
            let _ = process.wait();
        }
        self.clear(&request_id);
        let response = response?;
        if response.request_id != request_id {
            return Err("cleanup worker response request ID mismatch".into());
        }
        if response.status != "ok" {
            return Err(response.error.unwrap_or_else(|| {
                "cleanup worker returned an unknown error".into()
            }));
        }
        response
            .text
            .ok_or_else(|| "cleanup worker returned no text".into())
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        let active = self.active.lock().unwrap();
        if let Some(worker) = active.as_ref() {
            if worker.request_id == request_id {
                let _ = worker.child.lock().unwrap().kill();
                return true;
            }
        }
        drop(active);
        let mut cancelled = self.cancelled.lock().unwrap();
        if !cancelled.iter().any(|item| item == request_id) {
            if cancelled.len() == CANCELLED_REQUEST_LIMIT {
                cancelled.pop_front();
            }
            cancelled.push_back(request_id.to_owned());
        }
        true
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

    fn clear(&self, request_id: &str) {
        let mut active = self.active.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|item| item.request_id == request_id)
        {
            *active = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_worker_fails_honestly() {
        let supervisor = WorkerSupervisor::new(PathBuf::from("/missing"));
        let error = supervisor
            .run(Path::new("/model"), "prompt".into(), "r1".into())
            .unwrap_err();
        assert!(error.contains("not installed"));
    }

    #[test]
    fn cancellation_before_start_is_remembered_and_scoped() {
        let supervisor = WorkerSupervisor::new(PathBuf::from("/missing"));
        assert!(supervisor.cancel("r1"));
        let error = supervisor
            .run(Path::new("/model"), "prompt".into(), "r1".into())
            .unwrap_err();
        assert!(error.contains("cancelled"));
        let error = supervisor
            .run(Path::new("/model"), "prompt".into(), "r2".into())
            .unwrap_err();
        assert!(error.contains("not installed"));
    }
}
