//! Verification of model files already on disk (BUS-35, Codex P1).
//!
//! A file at the model path is trusted only after its exact size and SHA-256
//! matched the catalog pin once (`model_fetch::verify_file`, the same size +
//! SHA rule downloads use). The result is persisted as a marker next to the
//! model (`marker.rs`), so each file is hashed at most once. A changed length
//! or mtime, or a different pin, invalidates it. Within a session a
//! `Verified` keeps the fingerprint its hash saw and each use compares the
//! file against it (a stat, no hash, no marker read); a file changed
//! mid-session gets one background re-check. Hashing (`verify.rs`) runs only
//! on background threads (`background.rs`), never on the UI/IPC thread or
//! the transcription path: a model still being checked stays usable.
//!
//! A mismatched file (`Corrupt`) is not deleted: it is reported as `failed`
//! so the Models tab shows "Model file is damaged" with a one-click Retry
//! download, and transcription refuses it. A file that can't be opened or
//! read is failed too, so the user is never left with a dead "available"
//! row:
//! - `OpenFailed` ("unreadable": open or metadata failed): re-opened cheaply (no hash) on
//!   each status, list and resolve call; once it opens, the verdict clears,
//!   Settings re-lists and one background re-check is queued.
//! - `ReadFailed` ("read-failed": opened, but reading failed mid-hash): kept, like
//!   `Corrupt`, until Retry download or relaunch.
//! - A verified or not-yet-checked file that stops opening (e.g. chmod 000
//!   after it was marked) reads as unreadable while it fails; nothing is
//!   cached, so it is available again as soon as it opens.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::Path;

use super::ModelStore;
use crate::model_fetch::FetchError;
use crate::stt::catalog::ModelSpec;
use marker::Fingerprint;

mod background;
mod marker;
mod verify;

#[cfg(test)]
pub(super) use marker::{marker_path, write_marker};

/// Shown when a model file failed its SHA-256 / size check.
pub(super) const DAMAGED_MESSAGE: &str = "Model file is damaged. Download it again in Settings.";
/// Shown when a model file can't be opened (e.g. permissions).
pub(super) const UNREADABLE_MESSAGE: &str =
    "Couldn't open the model file. Try again, or download it again if this keeps happening.";
/// Shown when a model file opened but couldn't be read; retrying won't help.
pub(super) const READ_FAILED_MESSAGE: &str =
    "Couldn't read the model file. Download it again in Settings.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    Verified,
    Corrupt,
    /// Open or metadata failed (e.g. permissions); re-checked on each use.
    OpenFailed,
    /// Opened, but a read failed while hashing; kept until Retry/relaunch.
    ReadFailed,
}

impl Verdict {
    /// `failureReason` for the frontend, or `None` when the file is usable.
    pub(super) fn failure_reason(self) -> Option<&'static str> {
        match self {
            Self::Verified => None,
            Self::Corrupt => Some("damaged"),
            Self::OpenFailed => Some("unreadable"),
            Self::ReadFailed => Some("read-failed"),
        }
    }

    /// Message `resolved_path` refuses with, or `None` when usable.
    pub(super) fn refusal(self) -> Option<&'static str> {
        match self {
            Self::Verified => None,
            Self::Corrupt => Some(DAMAGED_MESSAGE),
            Self::OpenFailed => Some(UNREADABLE_MESSAGE),
            Self::ReadFailed => Some(READ_FAILED_MESSAGE),
        }
    }
}

/// What this session knows about a model file. `Verified` keeps the length
/// and mtime the hash (or a trusted marker) saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Cached {
    Verified(Fingerprint),
    Failed(Verdict),
}

impl Cached {
    fn verdict(self) -> Verdict {
        match self {
            Self::Verified(_) => Verdict::Verified,
            Self::Failed(verdict) => verdict,
        }
    }
}

pub(super) type VerdictMap = HashMap<&'static str, Cached>;
pub(super) type PendingSet = HashSet<&'static str>;

fn opens(model: &Path) -> bool {
    File::open(model).and_then(|f| f.metadata()).is_ok()
}

/// Verdict for a `verify_file` result. An I/O error is `OpenFailed` if the
/// file doesn't open now, else `ReadFailed` (it opened but couldn't be read).
pub(super) fn classify(result: Result<(), FetchError>, opens_now: bool) -> Verdict {
    match result {
        Ok(()) => Verdict::Verified,
        Err(FetchError::SizeMismatch { .. } | FetchError::HashMismatch { .. }) => Verdict::Corrupt,
        Err(_) if opens_now => Verdict::ReadFailed,
        Err(_) => Verdict::OpenFailed,
    }
}

impl ModelStore {
    /// Cached verdict, or the marker's, without hashing. `None` = not yet known.
    pub(super) fn known_verdict(&self, spec: &ModelSpec) -> Option<Verdict> {
        let cached = self.verdicts.lock().unwrap().get(spec.id).copied();
        match cached {
            Some(Cached::Verified(at)) => return self.recheck_verified(spec, at),
            Some(Cached::Failed(verdict)) => return Some(verdict),
            None => {}
        }
        let at = marker::trusted_fingerprint(spec, &self.model_path(spec))?;
        self.cache_verified(spec, at);
        Some(Verdict::Verified)
    }

    /// Verdict to act on now, never hashing or taking the hashing lock: only
    /// a cheap open + metadata of the file (see the module doc for the rules).
    pub(super) fn current_verdict(&self, spec: &ModelSpec) -> Option<Verdict> {
        let path = self.model_path(spec);
        match self.known_verdict(spec) {
            Some(Verdict::OpenFailed) if opens(&path) => {
                if self.clear_open_failed(spec) {
                    self.notify_models_changed();
                    self.queue_reverify(spec.id);
                }
                // A marker from an earlier hash may still vouch for the file.
                self.known_verdict(spec)
            }
            Some(Verdict::Verified) | None if !opens(&path) => Some(Verdict::OpenFailed),
            verdict => verdict,
        }
    }

    /// A `Verified` holds while the file still has the length and mtime it
    /// was verified at (a stat; no hash, no marker read, so a marker that
    /// couldn't be saved never causes re-hashing). A file changed
    /// mid-session reads as not-yet-checked and gets one background
    /// re-check, whose verdict replaces the cached one.
    fn recheck_verified(&self, spec: &ModelSpec, at: Fingerprint) -> Option<Verdict> {
        if marker::fingerprint(&self.model_path(spec)) == Some(at) {
            return Some(Verdict::Verified);
        }
        self.queue_reverify(spec.id);
        None
    }

    /// Remove the cached verdict only if it is still `OpenFailed` (checked
    /// under the same lock). Returns whether it was removed.
    fn clear_open_failed(&self, spec: &ModelSpec) -> bool {
        let mut verdicts = self.verdicts.lock().unwrap();
        if verdicts.get(spec.id) != Some(&Cached::Failed(Verdict::OpenFailed)) {
            return false;
        }
        verdicts.remove(spec.id);
        true
    }

    /// The cached verdict as is, without re-checking the file.
    fn cached_verdict(&self, model_id: &str) -> Option<Verdict> {
        let verdicts = self.verdicts.lock().unwrap();
        verdicts.get(model_id).map(|cached| cached.verdict())
    }

    /// Cache a failed check (`Verified` goes through `mark_verified`).
    pub(super) fn set_verdict(&self, spec: &ModelSpec, verdict: Verdict) {
        debug_assert_ne!(verdict, Verdict::Verified, "use mark_verified");
        self.verdicts
            .lock()
            .unwrap()
            .insert(spec.id, Cached::Failed(verdict));
    }

    fn cache_verified(&self, spec: &ModelSpec, at: Fingerprint) {
        self.verdicts
            .lock()
            .unwrap()
            .insert(spec.id, Cached::Verified(at));
    }
}
