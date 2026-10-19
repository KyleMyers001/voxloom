//! Verification of model files already on disk (BUS-35, Codex P1).
//!
//! A file at the model path is trusted only after its exact size and SHA-256
//! matched the catalog pin once (`model_fetch::verify_file`, the same size +
//! SHA rule downloads use). The result is persisted as a marker next to the model
//! (`<file>.verified`: `<sha256> <len> <mtime-ns>`), so each file is hashed at
//! most once. A changed length or mtime, or a different pin, invalidates it.
//! Hashing runs only on a background thread at startup, never on the UI/IPC
//! thread or the transcription path: a model still being checked stays usable.
//!
//! A mismatched file is not deleted: it is reported as `failed` so the Models
//! tab shows "Model file is damaged" with a one-click Retry download, and
//! transcription refuses it. A file that cannot be read is reported the same
//! way (`Unreadable`), so the user is never left with a dead "available" row.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::UNIX_EPOCH;

use super::ModelStore;
use crate::model_fetch::{self, FetchError};
use crate::stt::catalog::{self, ModelSpec};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    Verified,
    Corrupt,
    /// The file could not be opened or read (e.g. permissions).
    Unreadable,
}

pub(super) type VerdictMap = HashMap<&'static str, Verdict>;

pub(super) fn marker_path(model: &Path) -> PathBuf {
    let mut name = model.file_name().unwrap_or_default().to_os_string();
    name.push(".verified");
    model.with_file_name(name)
}

/// Length and mtime (ns since the epoch) that a marker records.
fn fingerprint(model: &Path) -> Option<(u64, u128)> {
    let meta = fs::metadata(model).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((meta.len(), mtime.as_nanos()))
}

/// Marker is trusted only if it names the pinned hash and the current length
/// and mtime. Older two-field markers are re-hashed once and rewritten.
fn marker_matches(spec: &ModelSpec, model: &Path) -> bool {
    let Some((len, mtime)) = fingerprint(model) else {
        return false;
    };
    let Ok(text) = fs::read_to_string(marker_path(model)) else {
        return false;
    };
    let mut parts = text.split_whitespace();
    parts
        .next()
        .is_some_and(|sha| sha.eq_ignore_ascii_case(spec.sha256))
        && parts.next().and_then(|n| n.parse::<u64>().ok()) == Some(len)
        && parts.next().and_then(|n| n.parse::<u128>().ok()) == Some(mtime)
}

pub(super) fn write_marker(spec: &ModelSpec, model: &Path) {
    if let Some((len, mtime)) = fingerprint(model) {
        let _ = fs::write(
            marker_path(model),
            format!("{} {len} {mtime}\n", spec.sha256),
        );
    }
}

impl ModelStore {
    /// Cached verdict, or the marker's, without hashing. `None` = not yet known.
    pub(super) fn known_verdict(&self, spec: &ModelSpec) -> Option<Verdict> {
        if let Some(v) = self.verdicts.lock().unwrap().get(spec.id) {
            return Some(*v);
        }
        if marker_matches(spec, &self.model_path(spec)) {
            self.set_verdict(spec, Verdict::Verified);
            return Some(Verdict::Verified);
        }
        None
    }

    pub(super) fn set_verdict(&self, spec: &ModelSpec, verdict: Verdict) {
        self.verdicts.lock().unwrap().insert(spec.id, verdict);
    }

    /// Hash the file once if needed (blocking; call off the main thread).
    pub(super) fn verify_existing(&self, spec: &ModelSpec) -> Option<Verdict> {
        let path = self.model_path(spec);
        if !path.is_file() {
            return None;
        }
        // One hash at a time; a second caller waits, then reuses the verdict.
        let _hashing = self.hashing.lock().unwrap();
        if let Some(v) = self.known_verdict(spec) {
            return Some(v);
        }
        let verdict = match model_fetch::verify_file(&path, &spec.artifact()) {
            Ok(()) => {
                write_marker(spec, &path);
                Verdict::Verified
            }
            Err(e @ (FetchError::SizeMismatch { .. } | FetchError::HashMismatch { .. })) => {
                // Sizes and hashes go to the log, not the UI.
                eprintln!("[stt] existing model {} failed verification: {e}", spec.id);
                Verdict::Corrupt
            }
            Err(e) => {
                eprintln!(
                    "[stt] could not read model {} for verification: {e}",
                    spec.id
                );
                Verdict::Unreadable
            }
        };
        self.set_verdict(spec, verdict);
        Some(verdict)
    }

    /// Startup: verify any present, unmarked model files on a background
    /// thread. `on_verdict` runs after each file is checked, so Settings can
    /// re-list (`stt:models-changed`). The handle is for tests; the app
    /// detaches it.
    pub fn spawn_verify_existing(
        self: &Arc<Self>,
        on_verdict: impl Fn() + Send + 'static,
    ) -> JoinHandle<()> {
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            for spec in catalog::CATALOG {
                if store.model_path(spec).is_file()
                    && store.known_verdict(spec).is_none()
                    && store.verify_existing(spec).is_some()
                {
                    on_verdict();
                }
            }
        })
    }
}
