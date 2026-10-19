//! English-first whisper.cpp model catalog (ADR local-stt-whisper).
//!
//! Every entry is pinned to an immutable Hugging Face revision of
//! `ggerganov/whisper.cpp` with its exact byte size and SHA-256 (the file's
//! LFS oid at that revision). Downloads are verified against both before the
//! file is renamed into place (`crate::model_fetch`).

use crate::model_fetch::PinnedArtifact;

/// Pinned `ggerganov/whisper.cpp` commit. Changing it requires updating every
/// size and SHA-256 below from the same revision (the catalog test enforces it).
#[allow(dead_code)]
pub const WHISPER_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub filename: &'static str,
    /// Exact byte size of the pinned file.
    pub size_bytes: u64,
    /// Lowercase hex SHA-256 of the pinned file.
    pub sha256: &'static str,
    /// Revision-pinned download URL (never a moving branch like `main`).
    pub url: &'static str,
}

impl ModelSpec {
    pub fn artifact(&self) -> PinnedArtifact {
        PinnedArtifact {
            size_bytes: self.size_bytes,
            sha256: self.sha256,
        }
    }
}

/// Suggested first download — tiny English.
#[allow(dead_code)]
pub const DEFAULT_MODEL_ID: &str = "whisper-tiny.en";

pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "whisper-tiny.en",
        label: "Whisper Tiny (English)",
        filename: "ggml-tiny.en.bin",
        size_bytes: 77_704_715,
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin",
    },
    ModelSpec {
        id: "whisper-base.en",
        label: "Whisper Base (English)",
        filename: "ggml-base.en.bin",
        size_bytes: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin",
    },
];

pub fn find(model_id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|m| m.id == model_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_pinned_to_the_revision_with_exact_identity() {
        for spec in CATALOG {
            let expected = format!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/{WHISPER_REVISION}/{}",
                spec.filename
            );
            assert_eq!(
                spec.url, expected,
                "{} must use the pinned revision",
                spec.id
            );
            assert!(!spec.url.contains("/resolve/main/"));
            assert_eq!(spec.sha256.len(), 64, "{} sha256 length", spec.id);
            assert!(spec
                .sha256
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
            assert!(spec.size_bytes > 1_000_000);
            assert_eq!(spec.artifact().size_bytes, spec.size_bytes);
        }
    }

    #[test]
    fn ids_and_filenames_are_unique() {
        for (i, a) in CATALOG.iter().enumerate() {
            for b in &CATALOG[i + 1..] {
                assert_ne!(a.id, b.id);
                assert_ne!(a.filename, b.filename);
            }
        }
    }
}
