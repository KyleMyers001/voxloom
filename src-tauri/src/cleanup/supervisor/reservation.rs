//! One admitted cleanup run: encode, spawn with the verified descriptor,
//! exchange one frame under the deadline, and always settle the slot on drop.

use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::super::protocol::{encode_frame, WorkerRequest, WorkerResponse};
use super::super::worker_process::{ProcessError, ProcessHandle, WorkerProcess};
use super::{response, SharedState, SupervisorError, WorkerSupervisor};

/// Reserves the native slot before verification/spawn. Cancellation is sticky
/// throughout reserved/starting/running; dropping is the sole settlement path.
pub struct WorkerReservation {
    /// When the renderer's budget ends, if it said (BUS-16 3c-2c).
    pub(super) deadline: Option<Instant>,
    pub(super) shared: Arc<SharedState>,
    pub(super) request_id: String,
    pub(super) started: bool,
    pub(super) timeout: Duration,
    pub(super) worker_path: PathBuf,
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

    pub fn set_deadline(&mut self, deadline: Option<Instant>) {
        self.deadline = deadline;
    }

    pub fn run(
        &mut self,
        model: &File,
        prompt: String,
        on_started: impl FnOnce(),
    ) -> Result<String, SupervisorError> {
        let path = self.worker_path.clone();
        self.run_with_spawn_and_started(prompt, || WorkerProcess::spawn(&path, model), on_started)
    }

    #[cfg(test)]
    pub(super) fn run_with_spawn(
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
        let mut request = WorkerRequest {
            model_path: "/dev/fd/3".into(),
            prompt,
            request_id: request_id.clone(),
            // Counted after the re-hash, just before the spawn.
            time_left_ms: super::super::budget::time_left_ms(self.deadline, Instant::now()),
            prewarm: false,
        };
        // Serialized once up front so an oversize request fails before any
        // child is spawned.
        let mut frame = encode_frame(&request).map_err(|_| SupervisorError {
            code: "context-overflow",
            message: "cleanup serialized request exceeds 128 KiB".into(),
        })?;
        // Checked at the lease too; this catches a worker removed since.
        if !WorkerSupervisor::path_available(&self.worker_path) {
            return Err(SupervisorError::worker_missing());
        }
        // A prewarm worker still loading or warming up takes this request
        // over its load instead of a second one (prewarm.rs).
        if let Some(handoff) = super::handoff::hand_over(&self.shared) {
            let handle = handoff.process.clone();
            return self.exchange(&request_id, handle, on_started, |deadline| {
                handoff.exchange(&frame, deadline)
            });
        }
        let process = spawn().map_err(SupervisorError::runtime)?;
        // The worker turns its time left into a deadline from its own start,
        // so what the spawn took must come out of it (BUS-124). The new value
        // is never larger, so it fits wherever the first one did; if it ever
        // failed to encode, the first frame still goes out.
        request.time_left_ms = super::super::budget::time_left_ms(self.deadline, Instant::now());
        if let Ok(fresh) = encode_frame(&request) {
            frame = fresh;
        }
        let handle = process.handle.clone();
        self.exchange(&request_id, handle, on_started, |deadline| {
            process.exchange(frame, deadline)
        })
    }

    /// Run one exchange with a started worker under the backstop deadline,
    /// with sticky cancellation, and map its reply.
    fn exchange(
        &mut self,
        request_id: &str,
        handle: ProcessHandle,
        on_started: impl FnOnce(),
        exchange: impl FnOnce(Instant) -> Result<WorkerResponse, ProcessError>,
    ) -> Result<String, SupervisorError> {
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
        let response = exchange(deadline);
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
        response::interpret(response, request_id)
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
        super::handoff::on_release(&mut state.prewarm);
        let disarmed = super::disarm::on_release(&mut state);
        drop(state);
        self.shared.settled.notify_all();
        if let Some(process) = disarmed {
            process.cancel();
        }
    }
}
