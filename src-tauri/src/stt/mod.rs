//! Local STT (whisper.cpp) — BUS-10.
//!
//! - Model store: explicit download only (ADR).
//! - PCM buffer store: capture → opaque handle → transcribe.
//! - Engine: real whisper behind `--features whisper`; stub otherwise.

pub mod catalog;
pub mod engine;
pub mod error;
pub mod store;

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::capture::pcm_store::PcmBufferStore;
use engine::TranscriptDto;
use error::SttErrorDto;
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

#[tauri::command]
pub fn stt_list_models(state: State<'_, SttState>) -> Vec<ModelInfoDto> {
    state.models.list()
}

#[tauri::command]
pub fn stt_model_status(
    state: State<'_, SttState>,
    model_id: String,
) -> Option<ModelInfoDto> {
    state.models.status(&model_id)
}

/// Explicit user-triggered download. Never invoked from constructors.
#[tauri::command]
pub fn stt_download_model(
    app: AppHandle,
    state: State<'_, SttState>,
    model_id: String,
) -> Result<(), String> {
    state
        .models
        .download(&app, &model_id)
        .map_err(err_string)
}

#[tauri::command]
pub fn stt_cancel_download(
    state: State<'_, SttState>,
    model_id: String,
) -> Result<(), String> {
    state.models.cancel(&model_id).map_err(err_string)
}

#[tauri::command]
pub fn stt_transcribe(
    state: State<'_, SttState>,
    model_id: String,
    buffer_id: String,
) -> Result<TranscriptDto, String> {
    if model_id.trim().is_empty() {
        return Err(err_string(SttErrorDto::new(
            "model-missing",
            "Explicit modelId is required for transcription",
        )));
    }
    let path = state.models.resolved_path(&model_id).map_err(err_string)?;
    let (samples, rate) = state
        .buffers
        .take(&buffer_id)
        .ok_or_else(|| {
            err_string(SttErrorDto::new(
                "unsupported-audio",
                format!("Unknown or already-consumed audio buffer: {buffer_id}"),
            ))
        })?;
    engine::transcribe_pcm(&path, &samples, rate).map_err(err_string)
}
