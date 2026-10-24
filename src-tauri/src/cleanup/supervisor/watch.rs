//! The prewarm worker's thread (prewarm.rs): it reads the worker's replies
//! and decides when the worker has nothing left to do.
//!
//! Replies come one per request frame, in order. The warm-up's and those of
//! dictations cut off after writing their frame (their budget ran out, or
//! they were cancelled) are owed to nobody and discarded; the reply after
//! them is the handed-over dictation's (BUS-120). A cut-off dictation leaves
//! the load to the next one (handoff.rs), so the worker is kept:
//! - while a dictation is handed over to it, with no time limit of its own,
//!   since that dictation's deadline bounds it;
//! - with nobody handed over, until its last owed reply is in, or for the
//!   prewarm's timeout from the start or from the last cut-off, whichever
//!   is first, so an orphaned load never runs on unbounded.
//!
//! Then the thread kills and reaps it.

use std::process::ChildStdout;
use std::sync::mpsc::{Receiver, Sender};
use std::time::Instant;

use super::super::protocol::{read_frame, WorkerResponse};
use super::prewarm::{PrewarmTicket, Reply, Slot};

pub(super) enum Event {
    Reply(Reply),
    /// A handed-over dictation was cut off (handoff.rs).
    Wake,
}

/// What a handed-over dictation waits for.
pub(super) enum Delivery {
    Reply(Reply),
    /// The user cancelled it (mod.rs).
    Cancelled,
}

impl PrewarmTicket {
    /// Until the worker has nothing left to do; the caller then reaps it.
    pub(super) fn watch(&self, events: Receiver<Event>) {
        let mut bound = Instant::now() + self.timeout;
        let mut was_live = false;
        loop {
            let live = self.live();
            if was_live && !live {
                bound = Instant::now() + self.timeout;
            }
            was_live = live;
            let event = if live {
                events.recv().ok()
            } else {
                events
                    .recv_timeout(bound.saturating_duration_since(Instant::now()))
                    .ok()
            };
            let keep = match event {
                Some(Event::Reply(reply)) => self.on_reply(reply),
                Some(Event::Wake) if !self.idle() => true,
                // Timed out, or a cut-off left nothing owed.
                Some(Event::Wake) | None => self.settle(),
            };
            if !keep {
                return;
            }
        }
    }

    /// Whether to keep the worker after this reply.
    fn on_reply(&self, reply: Reply) -> bool {
        let mut state = self.shared.state.lock().unwrap();
        let Some(Slot::Running {
            handoff,
            warmed,
            owed,
            ..
        }) = state.prewarm.as_mut()
        else {
            return false;
        };
        if reply.is_ok() && *owed > 0 {
            *owed -= 1;
            if *owed > 0 {
                return true;
            }
            drop(state);
            return self.settle();
        }
        // The handed-over dictation's reply, or the worker ended.
        *warmed = true;
        if let Some(handoff) = handoff.take() {
            let _ = handoff.send(Delivery::Reply(reply));
        }
        false
    }

    /// A dictation is handed over to the worker.
    fn live(&self) -> bool {
        matches!(
            self.shared.state.lock().unwrap().prewarm,
            Some(Slot::Running {
                handoff: Some(_),
                ..
            })
        )
    }

    /// No reply is owed, and nobody is handed over.
    fn idle(&self) -> bool {
        matches!(
            self.shared.state.lock().unwrap().prewarm,
            Some(Slot::Running {
                handoff: None,
                owed: 0,
                ..
            })
        )
    }
}

/// Every reply frame in order, then the read error that ends them.
pub(super) fn read_replies(mut stdout: ChildStdout, events: Sender<Event>) {
    std::thread::spawn(move || loop {
        let reply = read_frame::<WorkerResponse>(&mut stdout);
        let ended = reply.is_err();
        if events.send(Event::Reply(reply)).is_err() || ended {
            break;
        }
    });
}
