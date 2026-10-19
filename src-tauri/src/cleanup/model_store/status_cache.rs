//! Fingerprint cache so status() can skip a full SHA-256 when the
//! on-disk model is unchanged (dev/ino/size/mtime/ctime).

use std::fs;
use std::path::Path;
use std::time::SystemTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct FileFingerprint {
    #[cfg(unix)]
    pub(super) dev: u64,
    #[cfg(unix)]
    pub(super) ino: u64,
    pub(super) len: u64,
    pub(super) modified: SystemTime,
    /// Change-time (content or metadata). Catches in-place rewrites that
    /// restore mtime; userspace cannot forge it back on unix.
    #[cfg(unix)]
    pub(super) ctime_secs: i64,
    #[cfg(unix)]
    pub(super) ctime_nsecs: i64,
}

pub(super) fn fingerprint(path: &Path) -> Result<FileFingerprint, String> {
    // Match artifact::open_regular: never follow a symlink into the model path.
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("cleanup model must be a regular non-symlink file".into());
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
        #[cfg(unix)]
        ctime_secs: {
            use std::os::unix::fs::MetadataExt;
            metadata.ctime()
        },
        #[cfg(unix)]
        ctime_nsecs: {
            use std::os::unix::fs::MetadataExt;
            metadata.ctime_nsec()
        },
    })
}
