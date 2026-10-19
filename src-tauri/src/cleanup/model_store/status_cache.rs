//! Fingerprint cache so status() can skip a full SHA-256 when the
//! on-disk model is unchanged (inode/size/mtime).

use std::fs;
use std::path::Path;
use std::time::SystemTime;

use super::super::artifact::{validate as validate_artifact, ArtifactSpec};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct FileFingerprint {
    #[cfg(unix)]
    pub(super) dev: u64,
    #[cfg(unix)]
    pub(super) ino: u64,
    pub(super) len: u64,
    pub(super) modified: SystemTime,
}

pub(super) fn fingerprint(path: &Path) -> Result<FileFingerprint, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("cleanup model must be a regular file".into());
    }
    let modified = metadata
        .modified()
        .map_err(|error| format!("read cleanup model mtime: {error}"))?;
    Ok(FileFingerprint {
        #[cfg(unix)]
        dev: {
            use std::os::unix::fs::MetadataExt;
            metadata.dev()
        },
        #[cfg(unix)]
        ino: {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        },
        len: metadata.len(),
        modified,
    })
}

pub(super) fn available_cached(
    path: &Path,
    artifact: ArtifactSpec,
    verified: &mut Option<FileFingerprint>,
) -> bool {
    let Ok(fp) = fingerprint(path) else {
        *verified = None;
        return false;
    };
    if *verified == Some(fp) {
        return true;
    }
    match validate_artifact(path, artifact) {
        Ok(()) => {
            *verified = Some(fp);
            true
        }
        Err(_) => {
            *verified = None;
            false
        }
    }
}
