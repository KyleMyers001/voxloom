//! `<file>.verified` markers: `<sha256> <len> <mtime-ns>` next to a model that
//! passed its size + SHA-256 check, so it is hashed at most once.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::stt::catalog::ModelSpec;

pub(in crate::stt::store) fn marker_path(model: &Path) -> PathBuf {
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
pub(super) fn marker_matches(spec: &ModelSpec, model: &Path) -> bool {
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

pub(in crate::stt::store) fn write_marker(spec: &ModelSpec, model: &Path) {
    if let Some((len, mtime)) = fingerprint(model) {
        let _ = fs::write(
            marker_path(model),
            format!("{} {len} {mtime}\n", spec.sha256),
        );
    }
}
