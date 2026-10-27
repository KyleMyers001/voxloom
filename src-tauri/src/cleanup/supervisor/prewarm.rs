//! Prewarm, supervisor side (BUS-16 3c-2c C2). At most one prewarm worker
//! loads the model and warms it up (worker src/prewarm.rs). It never holds
//! the run slot, so a dictation is never refused because of it (the
//! dictation side, claim and handoff, is in handoff.rs):
//! - before the spawn (the model is still being hashed), a dictation's
//!   admission abandons the prewarm, since nothing is loading yet, and the
//!   prewarm stops hashing the model at its next chunk (BUS-125);
//! - while the worker loads or warms up, the dictation is handed to it as a
//!   second frame and reuses the load, never cancelled and never repeated;
//!   the worker cuts its warm-up short for it;
//!   a dictation admitted by then claims the worker, so it is kept for that
//!   dictation even if the warm-up replies while the dictation re-hashes;
//! - once the warm-up has replied with no claim, the prewarm worker is
//!   killed and reaped, and a dictation spawns its own, as before;
//! - if a dictation's budget runs out or the user cancels it, its handed-over
//!   load dies with it; the prewarm then starts over (re-arms) once the run
//!   slot is free, unless Low Power Mode is on;
//! - switching cleanup off disarms all of this (disarm.rs).

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
        /// The warm-up has replied (or timed out).
        warmed: bool,
        /// A dictation admitted before then holds the run slot.
        claimed: bool,
    },
}

/// The one prewarm; dropping it frees the prewarm slot.
pub struct PrewarmTicket {
    shared: Arc<SharedState>,
    timeout: Duration,
    worker_path: PathBuf,
}

/// Whether to skip the prewarm (macOS Low Power Mode), read on a re-arm.
pub type LowPowerMode = fn() -> bool;

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
    /// A dictation was admitted while this prewarm was reserved, so it has
    /// lost the right to spawn. Read between chunks of its model hash.
    pub fn abandoned(&self) -> bool {
        !matches!(
            self.shared.state.lock().unwrap().prewarm,
            Some(Slot::Reserved { abandoned: false })
        )
    }

    /// Spawn the prewarm worker on `model` and leave it to a thread that
    /// keeps `model` until the worker is reaped. False if a dictation came
    /// first or the worker could not start.
    pub fn start<M>(self, model: M, low_power_mode: LowPowerMode) -> bool
    where
        M: Borrow<File> + Send + 'static,
    {
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
            claimed: false,
        });
        drop(state);
        std::thread::spawn(move || {
            let cut_off = self.watch(stdout);
            process.finish();
            if cut_off && !low_power_mode() && self.rearm() {
                self.start(model, low_power_mode);
            }
        });
        true
    }

    /// Wait for the prewarm's reply and pass on a handed-over dictation's.
    /// The caller then kills and reaps the worker: once warm with nobody
    /// waiting, or stuck past the timeout, it has nothing left to do. True
    /// if a handed-over dictation was cut off (killed) before its reply.
    fn watch(&self, stdout: ChildStdout) -> bool {
        let replies = read_replies(stdout);
        // The prewarm's own reply first: warm, preempted, or a load error.
        let first = replies.recv_timeout(self.timeout);
        let timed_out = matches!(first, Err(RecvTimeoutError::Timeout));
        let Some(handoff) = self.settle() else {
            return false;
        };
        // A dictation is waiting on this worker; its own deadline bounds it.
        if timed_out {
            drop(replies.recv());
        }
        let reply = replies
            .recv()
            .unwrap_or_else(|_| Err("cleanup worker ended".into()));
        let cut_off = reply.is_err();
        let _ = handoff.send(reply);
        cut_off
    }

    /// Under the lock: no new handoff from here on. The handed-over
    /// dictation, if any; a claiming dictation still re-hashing is waited
    /// for, until it hands over or its reservation ends.
    pub(super) fn settle(&self) -> Option<Sender<Reply>> {
        let mut state = self.shared.state.lock().unwrap();
        loop {
            let Some(Slot::Running {
                handoff,
                warmed,
                claimed,
                ..
            }) = state.prewarm.as_mut()
            else {
                return None;
            };
            *warmed = true;
            if handoff.is_some() || !*claimed {
                return handoff.take();
            }
            state = self.shared.settled.wait(state).unwrap();
        }
    }

    /// Reserve the slot again once the cut-off dictation's run slot is free,
    /// so the restarted load is never alongside a dictation's own. False if
    /// cleanup was switched off meanwhile (disarm.rs).
    fn rearm(&self) -> bool {
        let mut state = self.shared.state.lock().unwrap();
        while state.active.is_some() {
            state = self.shared.settled.wait(state).unwrap();
        }
        super::disarm::may_rearm(&mut state)
    }
}

impl Drop for PrewarmTicket {
    fn drop(&mut self) {
        super::disarm::on_ticket_drop(&mut self.shared.state.lock().unwrap());
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
