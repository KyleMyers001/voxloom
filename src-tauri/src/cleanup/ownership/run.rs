//! One running cleanup: verify the held descriptor, run the reserved worker,
//! and on drop reap the process before releasing the descriptor and slot.

use std::sync::{Arc, Mutex};

use super::{Entry, RegistryInner, RequestKey, Result};
use crate::cleanup::model_store::ModelLease;
use crate::cleanup::supervisor::WorkerReservation;
use crate::cleanup::{CleanupAttempt, CleanupCommandError, CleanupRunOutput};

pub(in crate::cleanup) struct OwnedRun {
    pub(super) inner: Arc<Mutex<RegistryInner>>,
    pub(super) key: RequestKey,
    pub(super) ticket: u64,
    pub(super) lease: Option<ModelLease>,
    pub(super) permit: Option<WorkerReservation>,
}

impl OwnedRun {
    pub fn cancelled(&self) -> bool {
        self.permit.as_ref().unwrap().cancelled()
    }

    /// Bound the run by the renderer's budget (BUS-16 3c-2c).
    pub fn with_deadline(mut self, deadline: Option<std::time::Instant>) -> Self {
        self.permit.as_mut().unwrap().set_deadline(deadline);
        self
    }

    #[cfg(test)]
    pub fn run(self, prompt: String) -> Result<String> {
        self.run_with_attempt(prompt, |_| {})
            .map(|output| output.text)
    }

    pub fn run_with_attempt(
        mut self,
        prompt: String,
        on_started: impl FnOnce(CleanupAttempt),
    ) -> Result<CleanupRunOutput> {
        if self.cancelled() {
            return Err(CleanupCommandError::cancelled());
        }
        let verification = self.lease.as_mut().unwrap().verify();
        if self.cancelled() {
            return Err(CleanupCommandError::cancelled());
        }
        verification.map_err(CleanupCommandError::model)?;
        let lease = self.lease.as_ref().unwrap();
        let identity = lease.identity();
        let mut attempt = None;
        let result = self.permit.as_mut().unwrap().run(&lease.file, prompt, || {
            attempt = Some(identity.clone());
            on_started(identity);
        });
        match result {
            Ok(text) => Ok(CleanupRunOutput {
                text,
                attempt: attempt.unwrap(),
            }),
            Err(error) => {
                let mut error = CleanupCommandError::from(error);
                error.attempt = attempt;
                Err(error)
            }
        }
    }
}

impl Drop for OwnedRun {
    fn drop(&mut self) {
        // Keep import and admission excluded until the process is reaped. Then
        // release the descriptor before notifying cancellation waiters.
        self.permit.as_ref().unwrap().finish();
        drop(self.lease.take());
        let mut inner = self.inner.lock().unwrap();
        if matches!(inner.entries.get(&self.key), Some(Entry::Running(ticket)) if *ticket == self.ticket)
        {
            inner.entries.remove(&self.key);
        }
        drop(inner);
        drop(self.permit.take());
    }
}
