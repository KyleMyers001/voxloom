//! The dictation side of a prewarm (BUS-16 3c-2c C2, prewarm.rs): admission
//! claims a prewarm worker still loading or warming up, and the run hands
//! itself over as that worker's second frame; its reply comes back through
//! the prewarm's reader.

use std::process::ChildStdin;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Instant;

use super::super::protocol::{write_encoded_frame, WorkerResponse};
use super::super::worker_process::{ProcessError, ProcessHandle};
use super::prewarm::{Reply, Slot};
use super::SharedState;

/// A dictation's admission: a prewarm that hasn't spawned gives way, and one
/// that is still loading or warming up is kept for it.
pub(super) fn on_reserve(slot: &mut Option<Slot>) {
    match slot {
        Some(Slot::Reserved { abandoned }) => *abandoned = true,
        Some(Slot::Running {
            warmed: false,
            claimed,
            ..
        }) => *claimed = true,
        _ => {}
    }
}

/// The dictation's reservation ended, whether or not it handed over.
pub(super) fn on_release(slot: &mut Option<Slot>) {
    if let Some(Slot::Running { claimed, .. }) = slot {
        *claimed = false;
    }
}

/// A dictation handed to the prewarm worker: its process (for cancel), its
/// stdin (held open until the reply, as in worker_process.rs) and its reply.
pub(super) struct Handoff {
    pub process: ProcessHandle,
    stdin: ChildStdin,
    reply: Receiver<Reply>,
}

/// The running prewarm worker, unless it warmed up before this dictation
/// claimed it (or isn't there).
pub(super) fn hand_over(shared: &SharedState) -> Option<Handoff> {
    let mut state = shared.state.lock().unwrap();
    let Some(Slot::Running {
        process,
        stdin,
        handoff,
        warmed,
        claimed,
    }) = state.prewarm.as_mut()
    else {
        return None;
    };
    if *warmed && !*claimed {
        return None;
    }
    let stdin = stdin.take()?;
    let (sender, reply) = mpsc::channel();
    *handoff = Some(sender);
    // The prewarm may be waiting for this claim to hand over (settle).
    shared.settled.notify_all();
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
