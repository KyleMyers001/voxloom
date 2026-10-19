//! `<file>.verified` markers: `<sha256> <len> <mtime-ns>` next to a model that
//! passed its size + SHA-256 check, so it is hashed at most once across
//! launches. Within a session the in-memory fingerprint is what counts.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::stt::catalog::ModelSpec;

pub(in crate::stt::store) fn marker_path(model: &Path) -> PathBuf {
    let mut name = model.file_name().unwrap_or_default().to_os_string();
    name.push(".verified");
    model.with_file_name(name)
}

/// Length and mtime (ns since the epoch) of a model file.
pub(in crate::stt::store) type Fingerprint = (u64, u128);

/// The file's current fingerprint: a stat, no read.
pub(in crate::stt::store) fn fingerprint(model: &Path) -> Option<Fingerprint> {
    let meta = fs::metadata(model).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((meta.len(), mtime.as_nanos()))
}

/// The file's fingerprint if the marker vouches for it: the pinned hash and
/// the current length and mtime. Older two-field markers are re-hashed once
/// and rewritten.
pub(super) fn trusted_fingerprint(spec: &ModelSpec, model: &Path) -> Option<Fingerprint> {
    let (len, mtime) = fingerprint(model)?;
    let text = fs::read_to_string(marker_path(model)).ok()?;
    let mut parts = text.split_whitespace();
    let matches = parts
        .next()
        .is_some_and(|sha| sha.eq_ignore_ascii_case(spec.sha256))
        && parts.next().and_then(|n| n.parse::<u64>().ok()) == Some(len)
        && parts.next().and_then(|n| n.parse::<u128>().ok()) == Some(mtime);
    matches.then_some((len, mtime))
}

/// Record `at` (the fingerprint the hash saw) for the next launch. A failed
/// write only costs a re-hash then; this session trusts its memory.
pub(super) fn write(spec: &ModelSpec, model: &Path, at: Fingerprint) {
    let (len, mtime) = at;
    let text = format!("{} {len} {mtime}\n", spec.sha256);
    if let Err(e) = fs::write(marker_path(model), text) {
        eprintln!("[stt] couldn't save verified marker for {}: {e}", spec.id);
    }
}

/// Marker for the file as it is now (tests seed markers with this).
#[cfg(test)]
pub(in crate::stt::store) fn write_marker(spec: &ModelSpec, model: &Path) {
    if let Some(at) = fingerprint(model) {
        write(spec, model, at);
    }
}
