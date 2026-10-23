//! Disarming the prewarm (BUS-121). The native side can't see the cleanup
//! setting, so the renderer says when it is switched off, and this ends the
//! prewarm in whichever window it is in (prewarm.rs), never a dictation.
//!
//! Hashing the model: abandoned, as for a dictation (BUS-125), so it stops
//! at its next chunk and never spawns. Loading or warming up with nobody
//! claiming it: closed to claims and killed at once; the prewarm's own
//! thread reaps it and frees the slot. Claimed by a dictation: left running
//! for it. If that dictation ends without handing over (`on_release`), the
//! worker is killed then; if it is cut off, the prewarm is not re-armed
//! (`may_rearm`).
//!
//! A disarm lasts as long as the prewarm that was armed: the next one, after
//! the slot is free, starts as usual.

use super::prewarm::Slot;
use super::{SupervisorState, WorkerSupervisor};
use crate::cleanup::worker_process::ProcessHandle;

/// What a disarm found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disarmed {
    /// No prewarm was armed.
    Nothing,
    /// The prewarm was ended.
    Stopped,
    /// A dictation is using the prewarm's worker; only the re-arm is off.
    Kept,
}

impl WorkerSupervisor {
    pub fn disarm_prewarm(&self) -> Disarmed {
        let mut state = self.shared.state.lock().unwrap();
        let (found, process) = match state.prewarm.as_mut() {
            None => return Disarmed::Nothing,
            Some(Slot::Reserved { abandoned }) => {
                *abandoned = true;
                (Disarmed::Stopped, None)
            }
            Some(Slot::Running { claimed: true, .. }) => (Disarmed::Kept, None),
            Some(Slot::Running {
                process, warmed, ..
            }) => {
                // Warmed already: the prewarm's thread is reaping it.
                let kill = !std::mem::replace(warmed, true);
                (Disarmed::Stopped, kill.then(|| process.clone()))
            }
        };
        state.prewarm_disarmed = true;
        drop(state);
        // Not under the lock, as for a cancel: only the thread that owns the
        // worker waits on it.
        if let Some(process) = process {
            process.cancel();
        }
        found
    }
}

/// Under the lock, before a re-arm: reserve the slot again unless the
/// prewarm was disarmed meanwhile.
pub(super) fn may_rearm(state: &mut SupervisorState) -> bool {
    if state.prewarm_disarmed {
        return false;
    }
    state.prewarm = Some(Slot::Reserved { abandoned: false });
    true
}

/// Under the lock, when a dictation's reservation ends (after
/// `handoff::on_release` dropped its claim): a disarmed load that the
/// dictation claimed but never used, or finished with, has nothing left to
/// do. Closed to claims; the caller kills it once the lock is released. A
/// load that isn't disarmed stays for the next dictation to claim.
pub(super) fn on_release(state: &mut SupervisorState) -> Option<ProcessHandle> {
    if !state.prewarm_disarmed {
        return None;
    }
    match state.prewarm.as_mut() {
        Some(Slot::Running {
            process,
            warmed: warmed @ false,
            ..
        }) => {
            *warmed = true;
            Some(process.clone())
        }
        _ => None,
    }
}
