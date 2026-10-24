//! The dictation side of a prewarm (BUS-16 3c-2c C2, prewarm.rs): admission
//! claims a prewarm worker still loading or warming up, and the run hands
//! itself over as that worker's next frame; its reply comes back through
//! the prewarm's reader (watch.rs). Cut off before its reply, the dictation
//! leaves the load to the next one (BUS-120).

use std::process::ChildStdin;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Instant;

use super::super::protocol::{write_encoded_frame, WorkerResponse};
use super::super::worker_process::ProcessError;
use super::prewarm::Slot;
use super::watch::{Delivery, Event};
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

/// A dictation handed to the prewarm worker: its stdin (held open until the
/// reply, as in worker_process.rs) and its reply, or its cancellation.
pub(super) struct Handoff {
    shared: Arc<SharedState>,
    stdin: Option<ChildStdin>,
    /// Its frame went out, so the worker owes it a reply.
    written: bool,
    answered: bool,
    delivery: Receiver<Delivery>,
    cancel: Sender<Delivery>,
}

/// The running prewarm worker, unless it warmed up before this dictation
/// claimed it (or isn't there).
pub(super) fn hand_over(shared: &Arc<SharedState>) -> Option<Handoff> {
    let mut state = shared.state.lock().unwrap();
    let Some(Slot::Running {
        stdin,
        handoff,
        warmed,
        claimed,
        ..
    }) = state.prewarm.as_mut()
    else {
        return None;
    };
    if *warmed && !*claimed {
        return None;
    }
    let stdin = stdin.take()?;
    let (cancel, delivery) = mpsc::channel();
    *handoff = Some(cancel.clone());
    // The prewarm may be waiting for this claim to hand over (settle).
    shared.settled.notify_all();
    Some(Handoff {
        shared: Arc::clone(shared),
        stdin: Some(stdin),
        written: false,
        answered: false,
        delivery,
        cancel,
    })
}

impl Handoff {
    /// How a cancel reaches this dictation without killing the load.
    pub(super) fn canceller(&self) -> Sender<Delivery> {
        self.cancel.clone()
    }

    pub(super) fn exchange(
        &mut self,
        frame: &[u8],
        deadline: Instant,
    ) -> Result<WorkerResponse, ProcessError> {
        let cancelled = || {
            Err(ProcessError::Runtime(
                "cleanup request was cancelled".into(),
            ))
        };
        if matches!(self.delivery.try_recv(), Ok(Delivery::Cancelled)) {
            return cancelled();
        }
        let stdin = self.stdin.as_mut().expect("held until the handoff ends");
        // Before the write: a partial frame may still get a reply.
        self.written = true;
        write_encoded_frame(stdin, frame).map_err(ProcessError::Runtime)?;
        let wait = deadline.saturating_duration_since(Instant::now());
        match self.delivery.recv_timeout(wait) {
            Ok(Delivery::Reply(reply)) => {
                self.answered = true;
                reply.map_err(ProcessError::Runtime)
            }
            Ok(Delivery::Cancelled) => cancelled(),
            Err(RecvTimeoutError::Timeout) => Err(ProcessError::Timeout),
            Err(RecvTimeoutError::Disconnected) => {
                Err(ProcessError::Runtime("cleanup worker ended".into()))
            }
        }
    }
}

impl Drop for Handoff {
    /// Cut off before its reply: the slot reopens for the next dictation,
    /// and the reply it may still get is owed to nobody (watch.rs).
    fn drop(&mut self) {
        if self.answered {
            return;
        }
        let mut state = self.shared.state.lock().unwrap();
        // The reply may have come in just as the dictation gave up.
        while let Ok(delivery) = self.delivery.try_recv() {
            if matches!(delivery, Delivery::Reply(_)) {
                return;
            }
        }
        let Some(Slot::Running {
            stdin,
            handoff,
            claimed,
            owed,
            wake,
            ..
        }) = state.prewarm.as_mut()
        else {
            return;
        };
        *stdin = self.stdin.take();
        *handoff = None;
        *claimed = false;
        *owed += usize::from(self.written);
        let _ = wake.send(Event::Wake);
        drop(state);
        self.shared.settled.notify_all();
    }
}
