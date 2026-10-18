//! Optional local LLM cleanup (BUS-16), native side. Off by default: nothing
//! runs unless the renderer opts in and a worker plus an imported model exist.

mod artifact;
mod auth;
pub mod commands;
mod error;
pub mod model_store;
mod ownership;
mod picker;
pub mod protocol;
pub mod supervisor;
mod worker_process;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

pub use error::{CleanupAttempt, CleanupCommandError, CleanupRequestDto, CleanupRunOutput};
use model_store::CleanupModelStore;
use ownership::RequestRegistry;
use supervisor::WorkerSupervisor;

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
