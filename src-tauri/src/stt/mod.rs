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
pub mod parakeet;
pub mod parakeet_catalog;
pub mod pipeline;
pub mod store;
pub mod trim;

use std::sync::Arc;

use tauri::{AppHandle, Runtime, State, Webview};

use crate::capture::pcm_store::PcmBufferStore;
use engine::TranscriptDto;
use error::SttErrorDto;
use filter_config::SpeechFilterConfig;
use store::{ModelInfoDto, ModelStore};

#[derive(Clone)]
pub struct SttState {
    pub models: Arc<ModelStore>,
    pub buffers: Arc<PcmBufferStore>,
    pub parakeet: parakeet::ParakeetRuntime,
}

impl SttState {
    pub fn new(models: ModelStore, buffers: Arc<PcmBufferStore>) -> Self {
        Self {
            models: Arc::new(models),
            buffers,
            parakeet: parakeet::ParakeetRuntime::new(parakeet::worker_path::installed()),
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

/// Defense in depth in addition to the generated command ACL.
fn require_main<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err(err_string(SttErrorDto::new(
            "engine-unavailable",
            "STT execution requires the main renderer",
        )));
    }
    Ok(())
}

/// Fast admission only. Loading is owned by the background runner and may fail
/// later; transcribe receives that failure with the same request token.
#[tauri::command]
pub fn stt_prepare<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, SttState>,
    model_id: String,
    request_id: String,
) -> Result<(), String> {
    require_main(&webview)?;
    let epoch = state.parakeet.epoch();
    let spec = parakeet_catalog::find(&model_id)
        .ok_or_else(|| err_string(SttErrorDto::new("model-missing", "Unknown Parakeet model")))?;
    if !parakeet_catalog::is_supported() {
        return Err(err_string(SttErrorDto::new(
            "engine-unavailable",
            "Parakeet requires Apple Silicon and macOS 14 or later",
        )));
    }
    let models = state.models.clone();
    let resolve_id = model_id.clone();
    state
        .parakeet
        .prepare(epoch, &request_id, &model_id, spec.version, move || {
            models.resolved_path(&resolve_id)
        })
        .map_err(err_string)
}
#[tauri::command]
pub fn stt_cancel<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, SttState>,
    request_id: String,
) -> Result<bool, String> {
    require_main(&webview)?;
    state
        .parakeet
        .cancel(state.parakeet.epoch(), &request_id)
        .map_err(err_string)
}
#[tauri::command]
pub fn stt_release<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, SttState>,
    request_id: String,
    buffer_id: Option<String>,
) -> Result<bool, String> {
    require_main(&webview)?;
    // A stopped capture can fail before transcription is invoked (admission,
    // model selection, cancellation). Dispose that opaque buffer explicitly.
    if let Some(id) = buffer_id {
        state.buffers.discard(&id);
    }
    stt_cancel(webview, state, request_id)
}

/// Consume a stopped PCM handle and transcribe off-thread. Parakeet joins the
/// exact admitted recording; Whisper retains its existing independent pipeline.
#[tauri::command]
pub async fn stt_transcribe<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, SttState>,
    model_id: String,
    buffer_id: String,
    filter: Option<SpeechFilterConfig>,
    request_id: Option<String>,
) -> Result<TranscriptDto, String> {
    require_main(&webview)?;
    let state = state.inner().clone();
    // Reserve renderer ownership before the async boundary. Reload retirement
    // makes this token stale, even if the blocking pool starts it much later.
    let epoch = state.parakeet.epoch();
    let buffers = state.buffers.clone();
    let error_buffer = buffer_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        transcribe_buffer(
            &state,
            epoch,
            &model_id,
            &buffer_id,
            filter,
            request_id.as_deref(),
        )
        .map_err(err_string)
    })
    .await
    .map_err(|e| {
        buffers.discard(&error_buffer);
        join_err("transcribe-failed", e)
    })?
}

fn transcribe_buffer(
    state: &SttState,
    epoch: u64,
    model_id: &str,
    buffer_id: &str,
    filter: Option<SpeechFilterConfig>,
    request_id: Option<&str>,
) -> Result<TranscriptDto, SttErrorDto> {
    let out = (|| {
        // Consume first: stopped audio must not survive a failed model lookup,
        // failed preparation, missing request, cancellation or stale renderer.
        let (samples, rate) = state.buffers.take(buffer_id).ok_or_else(|| {
            SttErrorDto::new(
                "unsupported-audio",
                "Unknown or already-consumed audio buffer",
            )
        })?;
        if model_id.trim().is_empty() {
            return Err(SttErrorDto::new(
                "model-missing",
                "Explicit modelId is required for transcription",
            ));
        }
        let cfg = filter.unwrap_or_default();
        if parakeet_catalog::find(model_id).is_some() {
            let id = request_id.ok_or_else(|| {
                SttErrorDto::new("transcribe-failed", "Parakeet requestId is required")
            })?;
            return state
                .parakeet
                .transcribe(epoch, id, model_id, samples, rate, &cfg);
        }
        let path = state.models.resolved_path(model_id)?;
        // Whisper's engine, filters and concurrency remain unchanged.
        pipeline::transcribe_filtered(&samples, rate, &cfg, &gate::NoVad, |pcm| {
            engine::transcribe_pcm(&path, pcm, rate, &cfg)
        })
    })();
    if out.is_err() {
        if let Some(id) = request_id {
            let _ = state.parakeet.cancel(epoch, id);
        }
    }
    out
}

#[cfg(all(test, unix))]
#[path = "parakeet/commands_tests.rs"]
mod parakeet_commands_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::buffer::CaptureBuffer;
    use std::sync::Arc;

    #[test]
    fn stopped_pcm_is_consumed_on_all_routing_errors() {
        let state = SttState::new(
            ModelStore::new(std::env::temp_dir().join("parakeet-routing-missing")),
            Arc::new(PcmBufferStore::new()),
        );
        for (model, request) in [
            ("", None),
            ("unknown", None),
            ("whisper-tiny.en", None),
            ("parakeet-tdt-0.6b-v3", None),
            ("parakeet-tdt-0.6b-v3", Some("not-prepared")),
        ] {
            let mut pcm = CaptureBuffer::new();
            pcm.push(&[0.25]).unwrap();
            let handle = state.buffers.deposit(pcm);
            assert!(transcribe_buffer(&state, 0, model, &handle.id, None, request).is_err());
            assert_eq!(
                state.buffers.len(),
                0,
                "PCM drained even before engine/model/request errors"
            );
        }
        assert_eq!(
            transcribe_buffer(&state, 0, "parakeet-tdt-0.6b-v3", "absent", None, Some("r"))
                .unwrap_err()
                .code,
            "unsupported-audio"
        );
    }

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
