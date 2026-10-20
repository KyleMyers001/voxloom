//! A dictation handed to a prewarm worker that is still loading or warming
//! up (BUS-16 3c-2c C2, prewarm.rs): it is written as that worker's second
//! frame, and its reply comes back through the prewarm's reader.

use std::process::ChildStdin;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Instant;

use super::super::protocol::{write_encoded_frame, WorkerResponse};
use super::super::worker_process::{ProcessError, ProcessHandle};
use super::prewarm::{Reply, Slot};
use super::SharedState;

/// A dictation handed to the prewarm worker: its process (for cancel), its
/// stdin (held open until the reply, as in worker_process.rs) and its reply.
pub(super) struct Handoff {
    pub process: ProcessHandle,
    stdin: ChildStdin,
    reply: Receiver<Reply>,
}

/// The running prewarm worker, unless it has warmed up (or isn't there).
pub(super) fn hand_over(shared: &SharedState) -> Option<Handoff> {
    let mut state = shared.state.lock().unwrap();
    let Some(Slot::Running {
        process,
        stdin,
        handoff,
        warmed: false,
    }) = state.prewarm.as_mut()
    else {
        return None;
    };
    let stdin = stdin.take()?;
    let (sender, reply) = mpsc::channel();
    *handoff = Some(sender);
    Some(Handoff {
        process: process.clone(),
        stdin,
        reply,
    })
}

impl Handoff {
    pub(super) fn exchange(
        mut self,
        frame: &[u8],
        deadline: Instant,
    ) -> Result<WorkerResponse, ProcessError> {
        write_encoded_frame(&mut self.stdin, frame).map_err(ProcessError::Runtime)?;
        match self
            .reply
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(reply) => reply.map_err(ProcessError::Runtime),
            Err(RecvTimeoutError::Timeout) => Err(ProcessError::Timeout),
            Err(RecvTimeoutError::Disconnected) => {
                Err(ProcessError::Runtime("cleanup worker ended".into()))
            }
        }
    }
}
