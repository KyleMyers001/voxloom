//! Tauri commands for cleanup sessions, model management and worker runs.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Runtime, State, Webview};

use super::auth::{authorize_model_manager, owner, require_main, validate_request_id};
use super::model_store::{CleanupModelStore, ModelStatus};
use super::ownership::{Acquisition, OwnedRun, RequestRegistry};
use super::supervisor::WorkerSupervisor;
use super::{
    picker, CleanupAttempt, CleanupCommandError, CleanupRequestDto, CleanupRunOutput, CleanupState,
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
pub async fn cleanup_pick_and_import_model<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    state: State<'_, CleanupState>,
) -> Result<Option<ModelStatus>, CleanupCommandError> {
    authorize_model_manager(webview.label(), webview.window().label())?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(picker::pick_model_path());
    })
    .map_err(|error| CleanupCommandError::runtime(format!("open cleanup model picker: {error}")))?;
    let source = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|error| {
            CleanupCommandError::runtime(format!("model picker task failed: {error}"))
        })?
        .map_err(|error| {
            CleanupCommandError::runtime(format!("model picker closed unexpectedly: {error}"))
        })?
        .map_err(CleanupCommandError::runtime)?;
    let Some(source_path) = source else {
        return Ok(None);
    };
    let models = Arc::clone(&state.models);
    let mut status = tauri::async_runtime::spawn_blocking(move || {
        import_model(&models, PathBuf::from(source_path).as_path())
    })
    .await
    .map_err(|error| {
        CleanupCommandError::runtime(format!("model import task failed: {error}"))
    })??;
    status.runtime_available = state.supervisor.available();
    Ok(Some(status))
}

/// Import failures (in use, SHA mismatch, copy) are runtime errors. The
/// renderer reserves model-missing for "no usable model" from admission.
fn import_model(
    models: &CleanupModelStore,
    source: &Path,
) -> Result<ModelStatus, CleanupCommandError> {
    models.import(source).map_err(CleanupCommandError::runtime)
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
    let token = begin_acquire(&requests, &state.supervisor, owner, &request_id)?;
    let models = Arc::clone(&state.models);
    tauri::async_runtime::spawn_blocking(move || {
        requests.complete_acquire(token, models.lease(&model_id))
    })
    .await
    .map_err(|error| CleanupCommandError::runtime(format!("cleanup lease task failed: {error}")))?
}

/// Reserve the lease slot for a request. A build without a worker refuses
/// first, so the lease never hashes a model it can't run (BUS-135).
fn begin_acquire(
    requests: &RequestRegistry,
    supervisor: &WorkerSupervisor,
    owner: u64,
    request_id: &str,
) -> Result<Acquisition, CleanupCommandError> {
    supervisor.require_worker()?;
    requests.begin_acquire(owner, request_id)
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

#[cfg(all(test, unix))]
mod tests {
    use std::fs;

    use super::{import_model, CleanupModelStore};

    #[test]
    fn import_failures_are_runtime_errors_not_model_missing() {
        let root = crate::cleanup::test_support::test_root().join("commands-import");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = CleanupModelStore::new(root.join("installed"));
        let wrong = root.join("wrong.gguf");
        fs::write(&wrong, b"GGUFevil").unwrap();
        for source in [root.join("absent.gguf"), wrong] {
            let error = import_model(&store, &source).unwrap_err();
            assert_eq!(error.code, "runtime-error", "{source:?}: {}", error.message);
            assert!(!error.message.is_empty());
        }
        let _ = fs::remove_dir_all(root);
    }
}
