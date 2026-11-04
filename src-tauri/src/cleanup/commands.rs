//! Tauri commands for cleanup sessions, model management and worker runs.

use std::sync::Arc;

use tauri::{Runtime, State, Webview};

use super::auth::{authorize_model_manager, owner, require_main, validate_request_id};
use super::model_store::ModelStatus;
use super::ownership::{OwnedRun, RequestRegistry};
use super::{
    CleanupAttempt, CleanupCommandError, CleanupRequestDto, CleanupRunOutput, CleanupState,
};

#[tauri::command]
pub fn cleanup_session_open<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
) -> Result<String, CleanupCommandError> {
    require_main(&webview)?;
    let (owner, retired) = state.requests.open_session();
    tauri::async_runtime::spawn_blocking(move || retired.finish());
    Ok(owner.to_string())
}

#[tauri::command]
pub async fn cleanup_session_dispose<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
    session_id: String,
) -> Result<(), CleanupCommandError> {
    require_main(&webview)?;
    let retired = state.requests.retire(Some(owner(&session_id)?));
    tauri::async_runtime::spawn_blocking(move || retired.finish())
        .await
        .map_err(|error| {
            CleanupCommandError::runtime(format!("cleanup disposal task failed: {error}"))
        })
}

#[tauri::command]
pub async fn cleanup_model_status<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
) -> Result<ModelStatus, CleanupCommandError> {
    authorize_model_manager(webview.label(), webview.window().label())?;
    let models = Arc::clone(&state.models);
    let mut status = tauri::async_runtime::spawn_blocking(move || models.status())
        .await
        .map_err(|error| {
            CleanupCommandError::runtime(format!("model status task failed: {error}"))
        })?;
    status.runtime_available = state.supervisor.available();
    Ok(status)
}

#[tauri::command]
pub async fn cleanup_acquire<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
    session_id: String,
    model_id: String,
    request_id: String,
) -> Result<(), CleanupCommandError> {
    require_main(&webview)?;
    validate_request_id(&request_id)?;
    let owner = owner(&session_id)?;
    let requests = state.requests.clone();
    let token = requests.begin_acquire(owner, &request_id)?;
    let models = Arc::clone(&state.models);
    tauri::async_runtime::spawn_blocking(move || {
        requests.complete_acquire(token, models.lease(&model_id))
    })
    .await
    .map_err(|error| CleanupCommandError::runtime(format!("cleanup lease task failed: {error}")))?
}

#[tauri::command]
pub async fn cleanup_run<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
    session_id: String,
    request: CleanupRequestDto,
    on_started: tauri::ipc::Channel<CleanupAttempt>,
) -> Result<CleanupRunOutput, CleanupCommandError> {
    require_main(&webview)?;
    validate_request_id(&request.request_id)?;
    // raw_text is the transcript bound (not forwarded to the worker). The
    // renderer also checks this; keep the native guard for defense in depth.
    if request.raw_text.len() > 16_000 {
        return Err(CleanupCommandError {
            code: "context-overflow",
            message: "cleanup input exceeds 16000 UTF-8 bytes".into(),
            attempt: None,
        });
    }
    let running = start_run(&state.requests, &session_id, &request)?;
    tauri::async_runtime::spawn_blocking(move || {
        running.run_with_attempt(request.prompt, |attempt| {
            // Failure to reach a retired renderer does not erase evidence in
            // the final response; native cancellation owns process reclamation.
            let _ = on_started.send(attempt);
        })
    })
    .await
    .map_err(|error| CleanupCommandError::runtime(format!("cleanup task failed: {error}")))?
}

/// Admit a run bounded by the renderer's time left. The deadline is taken
/// here, before `run_with_attempt` re-hashes the model, so the re-hash is
/// paid for out of the same budget.
fn start_run(
    requests: &RequestRegistry,
    session_id: &str,
    request: &CleanupRequestDto,
) -> Result<OwnedRun, CleanupCommandError> {
    let deadline = super::budget::run_deadline(request.time_left_ms, std::time::Instant::now());
    Ok(requests
        .start_run(owner(session_id)?, &request.request_id, &request.model_id)?
        .with_deadline(deadline))
}

#[tauri::command]
pub async fn cleanup_cancel<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
    session_id: String,
    request_id: String,
) -> Result<bool, CleanupCommandError> {
    require_main(&webview)?;
    validate_request_id(&request_id)?;
    let owner = owner(&session_id)?;
    let requests = state.requests.clone();
    tauri::async_runtime::spawn_blocking(move || requests.settle(owner, &request_id))
        .await
        .map_err(|error| {
            CleanupCommandError::runtime(format!("cleanup cancellation task failed: {error}"))
        })?
}

#[tauri::command]
pub async fn cleanup_release<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
    session_id: String,
    request_id: String,
) -> Result<bool, CleanupCommandError> {
    cleanup_cancel(webview, state, session_id, request_id).await
}

#[cfg(all(test, unix))]
#[path = "commands_tests.rs"]
mod run_tests;
