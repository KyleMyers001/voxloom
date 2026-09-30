mod artifact;
pub mod model_store;
mod ownership;
mod picker;
pub mod protocol;
pub mod supervisor;
mod worker_process;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, State, Webview};

use model_store::{CleanupModelStore, ModelStatus};
use ownership::RequestRegistry;
use supervisor::WorkerSupervisor;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCommandError {
    code: &'static str,
    message: String,
}

impl CleanupCommandError {
    fn runtime(message: impl Into<String>) -> Self {
        Self {
            code: "runtime-error",
            message: message.into(),
        }
    }

    fn cancelled() -> Self {
        Self {
            code: "cancelled",
            message: "cleanup session or request was retired".into(),
        }
    }

    fn model(message: String) -> Self {
        Self {
            code: "model-missing",
            message,
        }
    }
}

impl From<supervisor::SupervisorError> for CleanupCommandError {
    fn from(error: supervisor::SupervisorError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRequestDto {
    model_id: String,
    prompt: String,
    raw_text: String,
    request_id: String,
}

pub struct CleanupState {
    requests: RequestRegistry,
    models: Arc<CleanupModelStore>,
    supervisor: Arc<WorkerSupervisor>,
}

impl CleanupState {
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        let models = CleanupModelStore::from_app(app)?;
        let resource = app
            .path()
            .resource_dir()
            .map_err(|error| format!("resolve resources: {error}"))?
            .join("cleanup")
            .join("voxloom-cleanup-worker");
        let worker_path = if resource.is_file() {
            resource
        } else {
            development_worker_path()
        };
        let supervisor = Arc::new(WorkerSupervisor::new(worker_path));
        Ok(Self {
            requests: RequestRegistry::new(Arc::clone(&supervisor)),
            models: Arc::new(models),
            supervisor,
        })
    }

    /// Invalidate immediately on the native lifecycle thread. Reaping belongs
    /// on the blocking pool, not the UI thread, and never drops a running lease.
    pub fn retire_main(&self, native_label: &str) {
        if native_label != "main" {
            return;
        }
        let retired = self.requests.retire(None);
        tauri::async_runtime::spawn_blocking(move || retired.finish());
    }
}

fn development_worker_path() -> PathBuf {
    #[cfg(debug_assertions)]
    return PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("cleanup")
        .join("voxloom-cleanup-worker");
    #[cfg(not(debug_assertions))]
    PathBuf::new()
}

fn authorize_labels(
    webview: &str,
    window: &str,
) -> Result<(), CleanupCommandError> {
    if webview != "main" || window != "main" {
        return Err(CleanupCommandError::runtime(
            "cleanup is restricted to the main webview",
        ));
    }
    Ok(())
}

fn require_main<R: Runtime>(
    webview: &Webview<R>,
) -> Result<(), CleanupCommandError> {
    // These labels come from Tauri's invoking Webview, never IPC arguments.
    authorize_labels(webview.label(), webview.window().label())
}

fn owner(session_id: &str) -> Result<u64, CleanupCommandError> {
    session_id
        .parse()
        .map_err(|_| CleanupCommandError::cancelled())
}

fn validate_request_id(id: &str) -> Result<(), CleanupCommandError> {
    if id.is_empty() || id.len() > 128 {
        return Err(CleanupCommandError::runtime(
            "cleanup request ID must be 1 to 128 bytes",
        ));
    }
    Ok(())
}

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
            CleanupCommandError::runtime(format!(
                "cleanup disposal task failed: {error}"
            ))
        })
}

#[tauri::command]
pub async fn cleanup_pick_and_import_model<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    state: State<'_, CleanupState>,
) -> Result<Option<ModelStatus>, String> {
    require_main(&webview).map_err(|error| error.message)?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(picker::pick_model_path());
    })
    .map_err(|error| format!("open cleanup model picker: {error}"))?;
    let source = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|error| format!("model picker task failed: {error}"))?
        .map_err(|error| {
            format!("model picker closed unexpectedly: {error}")
        })??;
    let Some(source_path) = source else {
        return Ok(None);
    };
    let models = Arc::clone(&state.models);
    let mut status = tauri::async_runtime::spawn_blocking(move || {
        models.import(PathBuf::from(source_path).as_path())
    })
    .await
    .map_err(|error| format!("model import task failed: {error}"))??;
    status.runtime_available = state.supervisor.available();
    Ok(Some(status))
}

#[tauri::command]
pub async fn cleanup_model_status<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
) -> Result<ModelStatus, String> {
    require_main(&webview).map_err(|error| error.message)?;
    let models = Arc::clone(&state.models);
    let mut status =
        tauri::async_runtime::spawn_blocking(move || models.status())
            .await
            .map_err(|error| format!("model status task failed: {error}"))?;
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
    .map_err(|error| {
        CleanupCommandError::runtime(format!(
            "cleanup lease task failed: {error}"
        ))
    })?
}

#[tauri::command]
pub async fn cleanup_run<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
    session_id: String,
    request: CleanupRequestDto,
) -> Result<String, CleanupCommandError> {
    require_main(&webview)?;
    validate_request_id(&request.request_id)?;
    if request.raw_text.len() > 16_000 {
        return Err(CleanupCommandError {
            code: "context-overflow",
            message: "cleanup input exceeds 16000 UTF-8 bytes".into(),
        });
    }
    let running = state.requests.start_run(
        owner(&session_id)?,
        &request.request_id,
        &request.model_id,
    )?;
    tauri::async_runtime::spawn_blocking(move || running.run(request.prompt))
        .await
        .map_err(|error| {
            CleanupCommandError::runtime(format!(
                "cleanup task failed: {error}"
            ))
        })?
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
    tauri::async_runtime::spawn_blocking(move || {
        requests.settle(owner, &request_id)
    })
    .await
    .map_err(|error| {
        CleanupCommandError::runtime(format!(
            "cleanup cancellation task failed: {error}"
        ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_native_main_webview_and_window_are_authorized() {
        assert!(authorize_labels("main", "main").is_ok());
        assert!(authorize_labels("overlay", "main").is_err());
        assert!(authorize_labels("main", "overlay").is_err());
        assert!(authorize_labels("overlay", "overlay").is_err());
        assert!(authorize_labels("", "main").is_err());
    }
}
