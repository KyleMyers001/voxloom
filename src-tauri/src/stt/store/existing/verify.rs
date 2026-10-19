//! Hashing a model file already on disk (blocking; background threads
//! only). A result counts only if the file kept the same length and mtime
//! for the whole hash; otherwise it describes bytes that are gone (e.g. a
//! download replaced the file) and is dropped.

use std::path::Path;

use super::super::ModelStore;
use super::marker::{self, Fingerprint};
use super::{classify, opens, Verdict};
use crate::model_fetch::{self, FetchError};
use crate::stt::catalog::ModelSpec;

/// Hashes tried while the file keeps changing underneath; then it stays
/// not-yet-checked (usable) until the next check.
const HASH_ATTEMPTS: usize = 3;

impl ModelStore {
    /// Hash the file once if needed (blocking; call off the main thread).
    pub(in crate::stt::store) fn verify_existing(&self, spec: &ModelSpec) -> Option<Verdict> {
        self.verify_existing_with(spec, |path| {
            model_fetch::verify_file(path, &spec.artifact())
        })
    }

    /// `verify_existing` with the hash step injected, so tests can change
    /// the file inside the hash window.
    pub(in crate::stt::store) fn verify_existing_with(
        &self,
        spec: &ModelSpec,
        mut hash: impl FnMut(&Path) -> Result<(), FetchError>,
    ) -> Option<Verdict> {
        let path = self.model_path(spec);
        if !path.is_file() {
            return None;
        }
        // One hash at a time; a second caller waits, then reuses the verdict.
        let _hashing = self.hashing.lock().unwrap();
        for _ in 0..HASH_ATTEMPTS {
            if let Some(verdict) = self.known_verdict(spec) {
                return Some(verdict);
            }
            let before = marker::fingerprint(&path)?;
            let result = hash(&path);
            if marker::fingerprint(&path) != Some(before) {
                eprintln!("[stt] existing model {} changed while hashing", spec.id);
                continue;
            }
            if let Err(e) = &result {
                // Sizes and hashes go to the log, not the UI.
                eprintln!("[stt] existing model {} failed verification: {e}", spec.id);
            }
            let opens_now = result.is_ok() || opens(&path);
            let verdict = classify(result, opens_now);
            if verdict == Verdict::Verified {
                self.mark_verified_at(spec, &path, before);
            } else {
                self.set_verdict(spec, verdict);
            }
            return Some(verdict);
        }
        None
    }

    /// `path` just passed its size + SHA-256 check while it had fingerprint
    /// `at`: trust it for this session and save the marker for the next.
    fn mark_verified_at(&self, spec: &ModelSpec, path: &Path, at: Fingerprint) {
        marker::write(spec, path, at);
        self.cache_verified(spec, at);
    }

    /// A download just verified and renamed `path` into place.
    pub(in crate::stt::store) fn mark_verified(&self, spec: &ModelSpec, path: &Path) {
        if let Some(at) = marker::fingerprint(path) {
            self.mark_verified_at(spec, path, at);
        }
    }
}
