mod artifact;
pub mod model_store;
mod picker;
pub mod protocol;
pub mod supervisor;
mod worker_process;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, State};

use model_store::{CleanupModelStore, ModelLease, ModelStatus};
use supervisor::WorkerSupervisor;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCommandError {
    code: &'static str,
    message: String,
}

impl CleanupCommandError {
    fn model(message: String) -> Self {
        Self {
            code: "model-missing",
            message,
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
    leases: Arc<Mutex<HashMap<String, (String, ModelLease)>>>,
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
        Ok(Self {
            leases: Arc::new(Mutex::new(HashMap::new())),
            models: Arc::new(models),
            supervisor: Arc::new(WorkerSupervisor::new(worker_path)),
        })
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

#[tauri::command]
pub async fn cleanup_pick_and_import_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CleanupState>,
) -> Result<Option<ModelStatus>, String> {
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
pub async fn cleanup_model_status(
    state: State<'_, CleanupState>,
) -> Result<ModelStatus, String> {
    let models = Arc::clone(&state.models);
    let mut status =
        tauri::async_runtime::spawn_blocking(move || models.status())
            .await
            .map_err(|error| format!("model status task failed: {error}"))?;
    status.runtime_available = state.supervisor.available();
    Ok(status)
}

#[tauri::command]
pub async fn cleanup_acquire(
    state: State<'_, CleanupState>,
    model_id: String,
    request_id: String,
) -> Result<(), CleanupCommandError> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(CleanupCommandError {
            code: "runtime-error",
            message: "cleanup request ID must be 1 to 128 bytes".into(),
        });
    }
    let lease_model_id = model_id.clone();
    let models = Arc::clone(&state.models);
    let lease = tauri::async_runtime::spawn_blocking(move || {
        models.lease(&model_id)
    })
    .await
    .map_err(|error| CleanupCommandError {
        code: "runtime-error",
        message: format!("cleanup lease task failed: {error}"),
    })?
    .map_err(CleanupCommandError::model)?;
    let mut leases = state.leases.lock().unwrap();
    if leases.contains_key(&request_id) {
        return Err(CleanupCommandError {
            code: "runtime-error",
            message: "cleanup request already has a model lease".into(),
        });
    }
    leases.insert(request_id, (lease_model_id, lease));
    Ok(())
}

#[tauri::command]
pub async fn cleanup_run(
    state: State<'_, CleanupState>,
    request: CleanupRequestDto,
) -> Result<String, CleanupCommandError> {
    if request.request_id.is_empty() || request.request_id.len() > 128 {
        return Err(CleanupCommandError {
            code: "runtime-error",
            message: "cleanup request ID must be 1 to 128 bytes".into(),
        });
    }
    if request.raw_text.as_bytes().len() > 16_000 {
        return Err(CleanupCommandError {
            code: "context-overflow",
            message: "cleanup input exceeds 16000 UTF-8 bytes".into(),
        });
    }
    let (leased_model_id, lease) = state
        .leases
        .lock()
        .unwrap()
        .remove(&request.request_id)
        .ok_or_else(|| CleanupCommandError::model(
            "cleanup model lease is unavailable".into(),
        ))?;
    if leased_model_id != request.model_id {
        return Err(CleanupCommandError::model(
            "cleanup model lease does not match request".into(),
        ));
    }
    let supervisor = Arc::clone(&state.supervisor);
    tauri::async_runtime::spawn_blocking(move || {
        supervisor
            .run(&lease.file, request.prompt, request.request_id)
            .map_err(|error| CleanupCommandError {
                code: error.code,
                message: error.message,
            })
    })
    .await
    .map_err(|error| CleanupCommandError {
        code: "runtime-error",
        message: format!("cleanup task failed: {error}"),
    })?
}

#[tauri::command]
pub fn cleanup_cancel(
    state: State<'_, CleanupState>,
    request_id: String,
) -> bool {
    if request_id.is_empty() || request_id.len() > 128 {
        return false;
    }
    state.leases.lock().unwrap().remove(&request_id);
    state.supervisor.cancel(&request_id)
}

#[tauri::command]
pub fn cleanup_release(
    state: State<'_, CleanupState>,
    request_id: String,
) -> bool {
    let removed = state.leases.lock().unwrap().remove(&request_id).is_some();
    state.supervisor.release(&request_id);
    removed
}
