//! English-first whisper.cpp model catalog (ADR local-stt-whisper).
//!
//! URLs are pinned to a Hugging Face commit of `ggerganov/whisper.cpp` so the
//! bytes behind each URL cannot change under the pinned `sha256`. Hashes are the
//! Git LFS object ids (SHA-256 of the file) published by Hugging Face for that
//! revision:
//! `https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/<REVISION>`
//! (also returned as `X-Linked-ETag` on the `resolve` URL).

/// Hugging Face commit of `ggerganov/whisper.cpp` the catalog is pinned to.
#[allow(dead_code)] // referenced by tests and docs
pub const HF_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    pub url: &'static str,
    /// Expected SHA-256 of the complete file, lowercase hex.
    pub sha256: &'static str,
}

/// Suggested first download — tiny English.
#[allow(dead_code)]
pub const DEFAULT_MODEL_ID: &str = "whisper-tiny.en";

pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "whisper-tiny.en",
        label: "Whisper Tiny (English)",
        filename: "ggml-tiny.en.bin",
        size_bytes: 77_700_000,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin",
        // LFS oid, 77_704_715 bytes.
        sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    },
    ModelSpec {
        id: "whisper-base.en",
        label: "Whisper Base (English)",
        filename: "ggml-base.en.bin",
        size_bytes: 148_000_000,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin",
        // LFS oid, 147_964_211 bytes.
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    },
];

pub fn find(model_id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|m| m.id == model_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_model_pins_a_sha256_and_revision() {
        for m in CATALOG {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
            assert!(
                m.url.contains(HF_REVISION),
                "{} url must pin the revision",
                m.id
            );
            assert!(m.url.ends_with(m.filename));
        }
    }
}
