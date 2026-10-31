//! Single-slot supervisor for the disposable cleanup worker. Admission and
//! cancellation state live here; one reservation owns a run (`reservation`),
//! worker replies are validated in `response`, and `prewarm` warms the model.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::worker_process::ProcessHandle;

mod disarm;
mod handoff;
mod prewarm;
mod reservation;
mod response;

pub use disarm::Disarmed;
pub use prewarm::LowPowerMode;
pub use reservation::WorkerReservation;

#[cfg(test)]
mod tests;

/// A backstop behind the renderer's budget (BUS-16 3c-2c, budget.rs).
const WORKER_TIMEOUT: Duration = super::budget::WORKER_TIMEOUT;
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
    prewarm: Option<prewarm::Slot>,
    /// The prewarm now armed was disarmed (disarm.rs); cleared with it.
    prewarm_disarmed: bool,
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

    /// Its own reason, so the renderer labels it "cleanup unavailable"
    /// rather than a failure (BUS-135).
    fn worker_missing() -> Self {
        Self {
            code: "worker-missing",
            message: "cleanup worker is not installed or not executable in this build".into(),
        }
    }
}

pub struct WorkerSupervisor {
    shared: Arc<SharedState>,
    prewarm_timeout: Duration,
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
            prewarm_timeout: prewarm::PREWARM_TIMEOUT,
            timeout,
            worker_path,
        }
    }

    pub fn available(&self) -> bool {
        Self::path_available(&self.worker_path)
    }

    /// `available`, as the error a lease or run refuses with (BUS-135).
    pub fn require_worker(&self) -> Result<(), SupervisorError> {
        if self.available() {
            Ok(())
        } else {
            Err(SupervisorError::worker_missing())
        }
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

    pub fn reserve(&self, request_id: String) -> Result<WorkerReservation, SupervisorError> {
        let mut state = self.shared.state.lock().unwrap();
        if let Some(index) = state.cancelled.iter().position(|id| id == &request_id) {
            state.cancelled.remove(index);
            return Err(Self::cancelled_error());
        }
        if state.active.is_some() {
            return Err(SupervisorError::runtime(
                "cleanup worker is already processing",
            ));
        }
        handoff::on_reserve(&mut state.prewarm);
        state.active = Some(ActiveWorker {
            process: None,
            cancelled: false,
            request_id: request_id.clone(),
        });
        Ok(WorkerReservation {
            shared: Arc::clone(&self.shared),
            request_id,
            deadline: None,
            started: false,
            timeout: self.timeout,
            worker_path: self.worker_path.clone(),
        })
    }

    /// Marks cancellation without doing process I/O; safe under the registry
    /// lock. The caller must subsequently cancel/reap outside that lock.
    pub(super) fn mark_cancelled(&self, request_id: &str) -> Option<ProcessHandle> {
        let mut state = self.shared.state.lock().unwrap();
        if let Some(active) = state.active.as_mut().filter(|a| a.request_id == request_id) {
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
