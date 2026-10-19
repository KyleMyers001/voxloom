use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

use super::artifact::{
    copy_private, open_regular, validate as validate_artifact, validate_file, ArtifactSpec,
};

pub const MODEL_ID: &str = "qwen3-0.6b-q4-k-m";
const MODEL_FILE: &str = "qwen3-0.6b-q4-k-m.gguf";
const MODEL_SHA256: &str = "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a";
const MODEL_SIZE: u64 = 396_705_472;

const ARTIFACT: ArtifactSpec = ArtifactSpec {
    sha256: MODEL_SHA256,
    size: MODEL_SIZE,
};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub available: bool,
    pub id: &'static str,
    pub runtime_available: bool,
    pub sha256: &'static str,
}

#[derive(Debug)]
struct StoreInner {
    importing: bool,
    leases: usize,
}

pub struct CleanupModelStore {
    inner: Arc<Mutex<StoreInner>>,
    root: PathBuf,
}

#[derive(Debug)]
pub struct ModelLease {
    pub file: File,
    artifact: ArtifactSpec,
    inner: Arc<Mutex<StoreInner>>,
}

impl ModelLease {
    pub(super) fn identity(&self) -> super::CleanupAttempt {
        super::CleanupAttempt {
            model_id: MODEL_ID,
            model_digest: self.artifact.sha256,
        }
    }

    /// Hash the already reserved descriptor, without holding the store lock.
    pub fn verify(&mut self) -> Result<(), String> {
        validate_file(&mut self.file, self.artifact)
    }
}

struct ImportGuard {
    inner: Arc<Mutex<StoreInner>>,
}

impl Drop for ImportGuard {
    fn drop(&mut self) {
        self.inner.lock().unwrap().importing = false;
    }
}

impl Drop for ModelLease {
    fn drop(&mut self) {
        let mut inner = self.inner.lock().unwrap();
        inner.leases = inner.leases.saturating_sub(1);
    }
}

impl CleanupModelStore {
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("resolve app data: {error}"))?
            .join("cleanup-models");
        Ok(Self::new(root))
    }

    pub fn new(root: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(StoreInner {
                importing: false,
                leases: 0,
            })),
            root,
        }
    }

    pub fn status(&self) -> ModelStatus {
        ModelStatus {
            available: validate_artifact(&self.model_path(), ARTIFACT).is_ok(),
            id: MODEL_ID,
            runtime_available: false,
            sha256: MODEL_SHA256,
        }
    }

    pub fn import(&self, source: &Path) -> Result<ModelStatus, String> {
        self.import_artifact(source, ARTIFACT)?;
        Ok(self.status())
    }

    pub(super) fn import_artifact(
        &self,
        source: &Path,
        artifact: ArtifactSpec,
    ) -> Result<(), String> {
        self.import_artifact_with_sync(source, artifact, |parent| {
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| format!("sync cleanup model directory: {error}"))
        })
    }

    fn import_artifact_with_sync(
        &self,
        source: &Path,
        artifact: ArtifactSpec,
        sync_parent: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        let _guard = self.begin_import()?;
        validate_artifact(source, artifact)?;
        fs::create_dir_all(&self.root)
            .map_err(|error| format!("create cleanup model directory: {error}"))?;
        let destination = self.model_path();
        if validate_artifact(&destination, artifact).is_ok() {
            // Also retry durability after a prior post-rename sync failure.
            return sync_parent(&self.root);
        }
        let temporary = self.root.join(format!("{MODEL_FILE}.partial"));
        if temporary.exists() {
            fs::remove_file(&temporary)
                .map_err(|error| format!("remove stale partial model: {error}"))?;
        }
        let result = copy_private(source, &temporary)
            .and_then(|()| validate_artifact(&temporary, artifact))
            .and_then(|()| {
                fs::rename(&temporary, &destination)
                    .map_err(|error| format!("finalize cleanup model: {error}"))?;
                sync_parent(&self.root)
            });
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn lease(&self, model_id: &str) -> Result<ModelLease, String> {
        self.lease_artifact(model_id, ARTIFACT)
    }

    pub(super) fn lease_artifact(
        &self,
        model_id: &str,
        artifact: ArtifactSpec,
    ) -> Result<ModelLease, String> {
        if model_id != MODEL_ID {
            return Err(format!("unknown cleanup model: {model_id}"));
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.importing {
            return Err("cleanup model is being imported".into());
        }
        if inner.leases >= 2 {
            return Err("cleanup model descriptor capacity is full".into());
        }
        let file = open_regular(&self.model_path())?;
        inner.leases += 1;
        Ok(ModelLease {
            file,
            artifact,
            inner: Arc::clone(&self.inner),
        })
    }

    fn model_path(&self) -> PathBuf {
        self.root.join(MODEL_FILE)
    }

    fn begin_import(&self) -> Result<ImportGuard, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.leases > 0 {
            return Err("cleanup model is in use".into());
        }
        if inner.importing {
            return Err("cleanup model import is already running".into());
        }
        inner.importing = true;
        Ok(ImportGuard {
            inner: Arc::clone(&self.inner),
        })
    }
}

#[cfg(test)]
mod tests;
