//! Pinned artifact identity, fetch errors and on-disk verification.

use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

/// Exact identity of a downloadable artifact: byte size plus lowercase
/// hex SHA-256 (for Hugging Face, the file's LFS oid at a pinned revision).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinnedArtifact {
    pub size_bytes: u64,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    Cancelled,
    Network(String),
    Io(String),
    SizeMismatch { expected: u64, actual: u64 },
    HashMismatch { expected: String, actual: String },
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => write!(f, "download cancelled"),
            Self::Network(msg) | Self::Io(msg) => write!(f, "{msg}"),
            Self::SizeMismatch { expected, actual } => write!(
                f,
                "size mismatch: expected {expected} bytes, received at least {actual}"
            ),
            Self::HashMismatch { expected, actual } => {
                write!(f, "SHA-256 mismatch: expected {expected}, got {actual}")
            }
        }
    }
}

/// Check an existing file against `artifact` (size first, then full hash).
/// Reads the whole file: call off the main thread.
pub fn verify_file(path: &Path, artifact: &PinnedArtifact) -> Result<(), FetchError> {
    let mut file = File::open(path).map_err(|e| FetchError::Io(format!("open: {e}")))?;
    let len = file
        .metadata()
        .map_err(|e| FetchError::Io(format!("metadata: {e}")))?
        .len();
    if len != artifact.size_bytes {
        return Err(FetchError::SizeMismatch {
            expected: artifact.size_bytes,
            actual: len,
        });
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| FetchError::Io(format!("read: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual.eq_ignore_ascii_case(artifact.sha256) {
        Ok(())
    } else {
        Err(FetchError::HashMismatch {
            expected: artifact.sha256.to_owned(),
            actual,
        })
    }
}
