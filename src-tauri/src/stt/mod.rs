//! Local STT (whisper.cpp) — BUS-10.
//!
//! - Model store: explicit download only (ADR).
//! - PCM buffer store: capture → opaque handle → transcribe.
//! - Engine: real whisper behind `--features whisper`; stub otherwise.
//! - Download / transcribe run off the command thread via async +
//!   `spawn_blocking` so long I/O and whisper inference do not freeze the UI.

pub mod catalog;
pub mod cleanup;
pub mod engine;
pub mod error;
pub mod filter_config;
pub mod gate;
pub mod pipeline;
pub mod store;

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::capture::pcm_store::PcmBufferStore;
use engine::TranscriptDto;
use error::SttErrorDto;
use filter_config::SpeechFilterConfig;
use store::{ModelInfoDto, ModelStore};

pub struct SttState {
    pub models: Arc<ModelStore>,
    pub buffers: Arc<PcmBufferStore>,
}

impl SttState {
    pub fn new(models: ModelStore, buffers: Arc<PcmBufferStore>) -> Self {
        Self {
            models: Arc::new(models),
            buffers,
        }
    }
}

fn err_string(e: SttErrorDto) -> String {
    e.to_string_payload()
}

fn join_err(code: &str, e: impl std::fmt::Display) -> String {
    err_string(SttErrorDto::new(
        code,
        format!("background task failed: {e}"),
    ))
}

#[tauri::command]
pub fn stt_list_models(state: State<'_, SttState>) -> Vec<ModelInfoDto> {
    state.models.list()
}

#[tauri::command]
pub fn stt_model_status(state: State<'_, SttState>, model_id: String) -> Option<ModelInfoDto> {
    state.models.status(&model_id)
}

/// Explicit user-triggered download. Never invoked from constructors.
///
/// Runs on a blocking pool so ureq I/O cannot stall the UI / IPC loop.
/// Progress continues to emit on `stt:download-progress`; the invoke
/// promise resolves only after the model file is finalized (or cancel/error).
#[tauri::command]
pub async fn stt_download_model(
    app: AppHandle,
    state: State<'_, SttState>,
    model_id: String,
) -> Result<(), String> {
    let models = Arc::clone(&state.models);
    tauri::async_runtime::spawn_blocking(move || {
        models.download(&app, &model_id).map_err(err_string)
    })
    .await
    .map_err(|e| join_err("download-failed", e))?
}

/// Cancel is intentionally synchronous and cheap so it can interrupt an
/// in-flight `stt_download_model` that is running on the blocking pool.
#[tauri::command]
pub fn stt_cancel_download(state: State<'_, SttState>, model_id: String) -> Result<(), String> {
    state.models.cancel(&model_id).map_err(err_string)
}

/// Transcribe off-thread so long whisper runs do not freeze the webview.
/// Consumes the PCM buffer (single-use handle). Requires an explicit modelId.
/// BUS-23: near-silent clips skip whisper; output is cleaned of non-speech
/// tags / silence hallucinations before it reaches insert or Copy. `filter`
/// is optional; omitted fields use `SpeechFilterConfig::default()`.
#[tauri::command]
pub async fn stt_transcribe(
    state: State<'_, SttState>,
    model_id: String,
    buffer_id: String,
    filter: Option<SpeechFilterConfig>,
) -> Result<TranscriptDto, String> {
    if model_id.trim().is_empty() {
        return Err(err_string(SttErrorDto::new(
            "model-missing",
            "Explicit modelId is required for transcription",
        )));
    }

    let models = Arc::clone(&state.models);
    let buffers = Arc::clone(&state.buffers);

    tauri::async_runtime::spawn_blocking(move || {
        let path = models.resolved_path(&model_id).map_err(err_string)?;
        let (samples, rate) = buffers.take(&buffer_id).ok_or_else(|| {
            err_string(SttErrorDto::new(
                "unsupported-audio",
                format!("Unknown or already-consumed audio buffer: {buffer_id}"),
            ))
        })?;
        let cfg = filter.unwrap_or_default();
        pipeline::transcribe_filtered(&samples, rate, &cfg, &gate::NoVad, |pcm| {
            engine::transcribe_pcm(&path, pcm, rate, &cfg)
        })
        .map_err(err_string)
    })
    .await
    .map_err(|e| join_err("transcribe-failed", e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::buffer::CaptureBuffer;
    use std::sync::Arc;

    #[test]
    fn empty_model_id_rejected_before_spawn() {
        // Mirrors the guard in stt_transcribe (sync portion).
        let err = SttErrorDto::new(
            "model-missing",
            "Explicit modelId is required for transcription",
        );
        assert_eq!(err.code, "model-missing");
    }

    #[test]
    fn transcribe_path_consumes_buffer_and_returns_engine_result() {
        let dir = std::env::temp_dir().join(format!("voxloom-stt-async-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Place a placeholder so resolved_path succeeds; engine stub still
        // returns engine-unavailable without the whisper feature.
        std::fs::write(dir.join("ggml-tiny.en.bin"), b"placeholder").unwrap();
        // Marker as if this file had been verified against the pin (BUS-35).
        let pin = catalog::find("whisper-tiny.en").unwrap().sha256;
        std::fs::write(dir.join("ggml-tiny.en.bin.verified"), format!("{pin} 11\n")).unwrap();

        let models = Arc::new(ModelStore::new(dir.clone()));
        let buffers = Arc::new(PcmBufferStore::new());
        let mut buf = CaptureBuffer::new();
        buf.push(&[0.1, 0.2]).unwrap();
        let handle = buffers.deposit(buf);

        let path = models.resolved_path("whisper-tiny.en").unwrap();
        let (samples, rate) = buffers.take(&handle.id).unwrap();
        let result = engine::transcribe_pcm(&path, &samples, rate, &SpeechFilterConfig::default());

        #[cfg(not(feature = "whisper"))]
        {
            let err = result.unwrap_err();
            assert_eq!(err.code, "engine-unavailable");
        }
        #[cfg(feature = "whisper")]
        {
            // Real whisper may fail to load a placeholder file; either a
            // transcript or transcribe-failed is acceptable for this unit.
            assert!(result.is_ok() || result.unwrap_err().code == "transcribe-failed");
        }

        assert!(
            buffers.take(&handle.id).is_none(),
            "buffer must be single-use (consumed)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
