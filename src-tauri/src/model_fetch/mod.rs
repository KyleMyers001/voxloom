//! Shared download-and-verify core for pinned model artifacts.
//!
//! Streams a URL into `<dest>.partial`, hashing while it writes, and only
//! renames into `dest` after the exact byte size **and** SHA-256 match the
//! pinned [`PinnedArtifact`]. Any failure (network, I/O, cancel, size or hash
//! mismatch) removes the partial file, so nothing unverified is ever left at
//! `dest`. Callers own progress presentation, single-flight bookkeeping and
//! user-facing error mapping (see `stt::store::download`).
//!
//! No network I/O happens unless [`fetch_verified`] is called.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};

mod verify;

#[allow(unused_imports)] // `verify_file` is for the planned LLM model store.
pub use verify::{verify_file, FetchError, PinnedArtifact};

#[cfg(test)]
mod tests;

/// Bytes between progress callbacks.
const PROGRESS_STEP: u64 = 256 * 1024;

/// `<dest>.partial` next to the destination (e.g. `ggml-tiny.en.bin.partial`).
pub fn partial_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    dest.with_file_name(name)
}

/// Download `url` to `dest`, verifying `artifact` before the atomic rename.
///
/// `on_progress(received, total)` fires every 256 KiB and at end of stream,
/// always **before** the rename; `total` is the pinned size. Completion is the
/// `Ok` return, after `dest` exists. Blocking: run off the main thread.
pub fn fetch_verified<F>(
    url: &str,
    dest: &Path,
    artifact: &PinnedArtifact,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<(), FetchError>
where
    F: FnMut(u64, u64),
{
    let tmp = partial_path(dest);
    let result = stream_to_partial(url, &tmp, artifact, cancel, &mut on_progress).and_then(|()| {
        if cancel.load(Ordering::Acquire) {
            return Err(FetchError::Cancelled);
        }
        fs::rename(&tmp, dest).map_err(|e| FetchError::Io(format!("finalize failed: {e}")))
    });
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn stream_to_partial<F>(
    url: &str,
    tmp: &Path,
    artifact: &PinnedArtifact,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<(), FetchError>
where
    F: FnMut(u64, u64),
{
    if let Some(dir) = tmp.parent() {
        fs::create_dir_all(dir).map_err(|e| FetchError::Io(format!("create models dir: {e}")))?;
    }
    let response = ureq::get(url)
        .call()
        .map_err(|e| FetchError::Network(format!("request failed: {e}")))?;
    let mut reader = response.into_reader();
    let mut file =
        File::create(tmp).map_err(|e| FetchError::Io(format!("create temp file: {e}")))?;

    let total = artifact.size_bytes;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut received: u64 = 0;
    let mut last_emit = 0u64;

    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(FetchError::Cancelled);
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| FetchError::Network(format!("read failed: {e}")))?;
        if n == 0 {
            break;
        }
        received += n as u64;
        // Never write past the pinned size: a wrong/oversized body fails fast.
        if received > total {
            return Err(FetchError::SizeMismatch {
                expected: total,
                actual: received,
            });
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n])
            .map_err(|e| FetchError::Io(format!("write failed: {e}")))?;
        if received - last_emit >= PROGRESS_STEP || received == total {
            last_emit = received;
            on_progress(received, total);
        }
    }

    file.flush()
        .and_then(|()| file.sync_all())
        .map_err(|e| FetchError::Io(format!("flush failed: {e}")))?;
    drop(file);

    if received != total {
        return Err(FetchError::SizeMismatch {
            expected: total,
            actual: received,
        });
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(artifact.sha256) {
        return Err(FetchError::HashMismatch {
            expected: artifact.sha256.to_owned(),
            actual,
        });
    }
    Ok(())
}
