//! English-first whisper.cpp model catalog (ADR local-stt-whisper).

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    pub url: &'static str,
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
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
    },
    ModelSpec {
        id: "whisper-base.en",
        label: "Whisper Base (English)",
        filename: "ggml-base.en.bin",
        size_bytes: 148_000_000,
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    },
];

pub fn find(model_id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|m| m.id == model_id)
}
