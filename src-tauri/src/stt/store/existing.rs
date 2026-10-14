//! Verification of model files already on disk (BUS-35, Codex P1).
//!
//! A file at the model path is trusted only after its SHA-256 matched the
//! catalog pin once. The result is persisted as a marker next to the model
//! (`<file>.verified`: `<sha256> <len>`), so each file is hashed at most once.
//! Hashing runs on a background thread at startup (never on the UI/IPC thread)
//! or, if transcription needs the model first, on its blocking worker.
//!
//! A mismatched file is not deleted: it is reported as `failed` so the Models
//! tab shows "Model file is corrupted" with Retry, and transcription refuses it.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::verify::Integrity;
use super::ModelStore;
use crate::stt::catalog::{self, ModelSpec};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Verdict {
    Verified,
    Corrupt,
}

pub(super) type VerdictMap = HashMap<&'static str, Verdict>;

pub(super) fn marker_path(model: &Path) -> PathBuf {
    let mut name = model.file_name().unwrap_or_default().to_os_string();
    name.push(".verified");
    model.with_file_name(name)
}

/// Marker is trusted only if it names the pinned hash and the current length.
fn marker_matches(spec: &ModelSpec, model: &Path) -> bool {
    let Ok(len) = fs::metadata(model).map(|m| m.len()) else {
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
}

pub(super) fn write_marker(spec: &ModelSpec, model: &Path) {
    if let Ok(meta) = fs::metadata(model) {
        let _ = fs::write(
            marker_path(model),
            format!("{} {}\n", spec.sha256, meta.len()),
        );
    }
}

fn hash_file(model: &Path) -> std::io::Result<String> {
    let mut file = File::open(model)?;
    let mut integrity = Integrity::default();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        integrity.update(&buf[..n]);
    }
    Ok(integrity.hex_digest())
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
        let verdict = match hash_file(&path) {
            Ok(actual) if actual.eq_ignore_ascii_case(spec.sha256) => {
                write_marker(spec, &path);
                Verdict::Verified
            }
            Ok(actual) => {
                eprintln!(
                    "[stt] existing model {} failed verification: expected sha256 {}, got {actual}",
                    spec.id, spec.sha256
                );
                Verdict::Corrupt
            }
            Err(e) => {
                eprintln!(
                    "[stt] could not read model {} for verification: {e}",
                    spec.id
                );
                return None;
            }
        };
        self.set_verdict(spec, verdict);
        Some(verdict)
    }

    /// Startup: verify any present, unmarked model files on a background thread.
    pub fn spawn_verify_existing(self: &Arc<Self>) {
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            for spec in catalog::CATALOG {
                if store.model_path(spec).is_file() && store.known_verdict(spec).is_none() {
                    store.verify_existing(spec);
                }
            }
        });
    }
}
