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
//!   load is kept (BUS-120, watch.rs): the next dictation reuses it, and
//!   with nobody waiting it ends once its last reply is in, or at the
//!   prewarm's timeout;
//! - switching cleanup off disarms all of this (disarm.rs).

use std::borrow::Borrow;
use std::fs::File;
use std::path::PathBuf;
use std::process::ChildStdin;
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::Duration;

use super::super::protocol::{encode_frame, write_encoded_frame};
use super::super::protocol::{WorkerRequest, WorkerResponse};
use super::super::worker_process::{ProcessHandle, WorkerProcess};
use super::watch::{read_replies, Delivery, Event};
use super::{SharedState, WorkerSupervisor};

/// How long a prewarm may load and warm up with no dictation waiting on it,
/// and how long a kept load may run on once nobody waits on it (watch.rs).
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
        handoff: Option<Sender<Delivery>>,
        /// Closed to claims: the prewarm is ending.
        warmed: bool,
        /// A dictation admitted before then holds the run slot.
        claimed: bool,
        /// Replies owed to nobody, due before a handed-over dictation's: the
        /// warm-up's, and those of dictations cut off after their frame.
        owed: usize,
        /// Wakes the prewarm's thread when a dictation is cut off.
        wake: Sender<Event>,
    },
}

/// The one prewarm; dropping it frees the prewarm slot.
pub struct PrewarmTicket {
    pub(super) shared: Arc<SharedState>,
    pub(super) timeout: Duration,
    worker_path: PathBuf,
}

/// Whether to skip the prewarm (macOS Low Power Mode), read at launch.
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
    pub fn start<M>(self, model: M) -> bool
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
        let (wake, events) = mpsc::channel();
        state.prewarm = Some(Slot::Running {
            process: process.clone(),
            stdin: Some(stdin),
            handoff: None,
            warmed: false,
            claimed: false,
            owed: 1,
            wake: wake.clone(),
        });
        drop(state);
        read_replies(stdout, wake);
        std::thread::spawn(move || {
            self.watch(events);
            process.finish();
            drop(model);
        });
        true
    }

    /// Under the lock, once nothing is owed, nobody waits any more or the
    /// bound ran out (`timed_out`): whether to keep the worker. Kept while a
    /// dictation is handed over to it; a claiming dictation still re-hashing
    /// is waited for, until it hands over or its reservation ends. Then kept
    /// if that dictation was cut off owing a reply, unless the bound ran out
    /// (watch.rs). Otherwise closed to claims.
    pub(super) fn settle(&self, timed_out: bool) -> bool {
        let mut state = self.shared.state.lock().unwrap();
        loop {
            let Some(Slot::Running {
                handoff,
                warmed,
                claimed,
                owed,
                ..
            }) = state.prewarm.as_mut()
            else {
                return false;
            };
            if handoff.is_some() {
                return true;
            }
            if !*claimed {
                if *owed > 0 && !timed_out {
                    return true;
                }
                *warmed = true;
                return false;
            }
            state = self.shared.settled.wait(state).unwrap();
        }
    }
}

impl Drop for PrewarmTicket {
    fn drop(&mut self) {
        super::disarm::on_ticket_drop(&mut self.shared.state.lock().unwrap());
        self.shared.settled.notify_all();
    }
}
