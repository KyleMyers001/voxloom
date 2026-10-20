//! Optional local LLM cleanup (BUS-16), native side. Off by default: nothing
//! runs unless the renderer opts in and a worker plus an imported model exist.

mod artifact;
mod auth;
mod budget;
pub mod commands;
mod error;
pub mod model_store;
mod ownership;
mod picker;
pub mod protocol;
#[cfg(all(test, unix))]
mod state_tests;
pub mod supervisor;
#[cfg(all(test, unix))]
mod test_support;
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
        // Model store first. A resource-dir / worker-path miss must not discard
        // a working app-data store — disable the runtime instead.
        let models = CleanupModelStore::from_app(app)?;
        let worker_path = match Self::worker_path(app) {
            Ok(path) => path,
            Err(error) => {
                eprintln!("[cleanup] worker path unavailable, cleanup runtime disabled: {error}");
                PathBuf::new()
            }
        };
        Ok(Self::with_parts(models, worker_path))
    }

    fn worker_path(app: &AppHandle) -> Result<PathBuf, String> {
        let resource = app
            .path()
            .resource_dir()
            .map_err(|error| format!("resolve resources: {error}"))?
            .join("cleanup")
            .join("voxloom-cleanup-worker");
        Ok(if resource.is_file() {
            resource
        } else {
            development_worker_path()
        })
    }

    /// Same shape as a normal store, pointed at a disposable temp root and an
    /// empty worker path so status reports unavailable instead of crashing
    /// startup when app-data resolution fails (off-by-default feature).
    pub fn fallback() -> Self {
        Self::with_parts(
            CleanupModelStore::new(std::env::temp_dir().join("voxloom-cleanup-models")),
            PathBuf::new(),
        )
    }

    /// Startup: the `from_app` result, or (after logging why setup failed)
    /// the disposable fallback, so app-data resolution never crashes startup.
    pub fn or_fallback(result: Result<Self, String>) -> Self {
        result.unwrap_or_else(|error| {
            eprintln!("[cleanup] setup failed, using disposable fallback: {error}");
            Self::fallback()
        })
    }

    fn with_parts(models: CleanupModelStore, worker_path: PathBuf) -> Self {
        let supervisor = Arc::new(WorkerSupervisor::new(worker_path));
        Self {
            requests: RequestRegistry::new(Arc::clone(&supervisor)),
            models: Arc::new(models),
            supervisor,
        }
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
