//! Prewarm, supervisor side (BUS-16 3c-2c C2). At most one prewarm worker
//! loads the model and warms it up (worker src/prewarm.rs). It never holds
//! the run slot, so a dictation is never refused because of it:
//! - before the spawn (the model is still being hashed), a dictation's
//!   admission abandons the prewarm, since nothing is loading yet;
//! - while the worker loads or warms up, the dictation is handed to it as a
//!   second frame and reuses the load, never cancelled and never repeated;
//!   the worker cuts its warm-up short for it;
//!   (the dictation side is in handoff.rs);
//! - once the warm-up has replied, the prewarm worker is closed and a
//!   dictation spawns its own, as before.

use std::borrow::Borrow;
use std::fs::File;
use std::path::PathBuf;
use std::process::{ChildStdin, ChildStdout};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

use super::super::protocol::{encode_frame, read_frame, write_encoded_frame};
use super::super::protocol::{WorkerRequest, WorkerResponse};
use super::super::worker_process::{ProcessHandle, WorkerProcess};
use super::{SharedState, WorkerSupervisor};

/// How long a prewarm may load and warm up with no dictation waiting on it.
/// Provisional: room for a cold load of Qwen3-1.7B; tuned after BUS-114.
pub(super) const PREWARM_TIMEOUT: Duration = Duration::from_secs(60);
/// A fixed tiny prompt; the warm-up reply is discarded.
const PROMPT: &str = "Fix punctuation and capitalization. Reply with the text only.\n\nhello world";
const REQUEST_ID: &str = "prewarm";

pub(super) type Reply = Result<WorkerResponse, String>;

pub(super) enum Slot {
    /// Reserved while the model is verified; a dictation abandons it.
    Reserved { abandoned: bool },
    /// The worker is loading or warming up.
    Running {
        process: ProcessHandle,
        stdin: Option<ChildStdin>,
        handoff: Option<Sender<Reply>>,
        warmed: bool,
    },
}

/// A dictation's admission: a prewarm that hasn't spawned gives way.
pub(super) fn on_reserve(slot: &mut Option<Slot>) {
    if let Some(Slot::Reserved { abandoned }) = slot {
        *abandoned = true;
    }
}

/// The one prewarm; dropping it frees the prewarm slot.
pub struct PrewarmTicket {
    shared: Arc<SharedState>,
    timeout: Duration,
    worker_path: PathBuf,
}

impl WorkerSupervisor {
    /// None while a run or another prewarm is in.
    pub fn reserve_prewarm(&self) -> Option<PrewarmTicket> {
        let mut state = self.shared.state.lock().unwrap();
        if state.active.is_some() || state.prewarm.is_some() {
            return None;
        }
        state.prewarm = Some(Slot::Reserved { abandoned: false });
        Some(PrewarmTicket {
            shared: Arc::clone(&self.shared),
            timeout: self.prewarm_timeout,
            worker_path: self.worker_path.clone(),
        })
    }
}

impl PrewarmTicket {
    /// Spawn the prewarm worker on `model` and leave it to a thread that
    /// keeps `model` until the worker is reaped. False if a dictation came
    /// first or the worker could not start.
    pub fn start<M: Borrow<File> + Send + 'static>(self, model: M) -> bool {
        let frame = encode_frame(&WorkerRequest {
            model_path: "/dev/fd/3".into(),
            prompt: PROMPT.into(),
            request_id: REQUEST_ID.into(),
            time_left_ms: None,
            prewarm: true,
        })
        .expect("the prewarm frame is small");
        // Under the lock, so a dictation sees either no prewarm or a
        // running one, never a half-started one. Spawning and writing a
        // small frame to an empty pipe don't wait on the worker.
        let mut state = self.shared.state.lock().unwrap();
        if !matches!(state.prewarm, Some(Slot::Reserved { abandoned: false })) {
            return false;
        }
        let Ok(process) = WorkerProcess::spawn(&self.worker_path, model.borrow()) else {
            return false;
        };
        let (process, mut stdin, stdout) = process.into_parts();
        if write_encoded_frame(&mut stdin, &frame).is_err() {
            drop(state);
            process.finish();
            return false;
        }
        state.prewarm = Some(Slot::Running {
            process: process.clone(),
            stdin: Some(stdin),
            handoff: None,
            warmed: false,
        });
        drop(state);
        std::thread::spawn(move || {
            self.watch(&process, stdout);
            process.finish();
            drop(model);
        });
        true
    }

    fn watch(&self, process: &ProcessHandle, stdout: ChildStdout) {
        let replies = read_replies(stdout);
        // The prewarm's own reply first: warm, preempted, or a load error.
        let first = replies.recv_timeout(self.timeout);
        let timed_out = matches!(first, Err(RecvTimeoutError::Timeout));
        let Some(handoff) = self.settle() else {
            if timed_out {
                process.cancel();
            }
            return;
        };
        // A dictation is waiting on this worker; its own deadline bounds it.
        if timed_out {
            drop(replies.recv());
        }
        let reply = replies
            .recv()
            .unwrap_or_else(|_| Err("cleanup worker ended".into()));
        let _ = handoff.send(reply);
    }

    /// Under the lock: no handoff from here on, and without one, stdin
    /// closes (which ends the worker). The handed-over dictation, if any.
    fn settle(&self) -> Option<Sender<Reply>> {
        let mut state = self.shared.state.lock().unwrap();
        let Some(Slot::Running {
            stdin,
            handoff,
            warmed,
            ..
        }) = state.prewarm.as_mut()
        else {
            return None;
        };
        *warmed = true;
        drop(stdin.take());
        handoff.take()
    }
}

impl Drop for PrewarmTicket {
    fn drop(&mut self) {
        self.shared.state.lock().unwrap().prewarm = None;
        self.shared.settled.notify_all();
    }
}

/// Every reply frame in order, then the read error that ends them.
fn read_replies(mut stdout: ChildStdout) -> Receiver<Reply> {
    let (sender, replies) = mpsc::channel();
    std::thread::spawn(move || loop {
        let reply = read_frame::<WorkerResponse>(&mut stdout);
        let ended = reply.is_err();
        if sender.send(reply).is_err() || ended {
            break;
        }
    });
    replies
}
