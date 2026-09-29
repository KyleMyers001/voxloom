use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

use super::artifact::{
    copy_private, open_verified, validate as validate_artifact, ArtifactSpec,
};

pub const MODEL_ID: &str = "qwen3-0.6b-q4-k-m";
const MODEL_FILE: &str = "qwen3-0.6b-q4-k-m.gguf";
const MODEL_SHA256: &str =
    "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a";
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
    inner: Arc<Mutex<StoreInner>>,
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

    fn import_artifact(
        &self,
        source: &Path,
        artifact: ArtifactSpec,
    ) -> Result<(), String> {
        let _guard = self.begin_import()?;
        validate_artifact(source, artifact)?;
        fs::create_dir_all(&self.root).map_err(|error| {
            format!("create cleanup model directory: {error}")
        })?;
        let destination = self.model_path();
        if validate_artifact(&destination, artifact).is_ok() {
            return Ok(());
        }
        let temporary = self.root.join(format!("{MODEL_FILE}.partial"));
        if temporary.exists() {
            fs::remove_file(&temporary).map_err(|error| {
                format!("remove stale partial model: {error}")
            })?;
        }
        let result = copy_private(source, &temporary)
            .and_then(|()| validate_artifact(&temporary, artifact))
            .and_then(|()| {
                fs::rename(&temporary, &destination)
                    .map_err(|error| format!("finalize cleanup model: {error}"))
            });
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn lease(&self, model_id: &str) -> Result<ModelLease, String> {
        self.lease_artifact(model_id, ARTIFACT)
    }

    fn lease_artifact(
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
        let file = open_verified(&self.model_path(), artifact)?;
        inner.leases += 1;
        Ok(ModelLease {
            file,
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
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("voxloom-cleanup-{name}-{}", std::process::id(),))
    }

    #[test]
    fn imports_atomically_with_private_permissions() {
        let root = temp_root("import");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.gguf");
        fs::write(&source, b"GGUFtest").unwrap();
        let digest = Box::leak(
            format!("{:x}", Sha256::digest(b"GGUFtest")).into_boxed_str(),
        );
        let installed = root.join("installed");
        let store = CleanupModelStore::new(installed.clone());
        store
            .import_artifact(
                &source,
                ArtifactSpec {
                    sha256: digest,
                    size: 8,
                },
            )
            .unwrap();
        let destination = installed.join(MODEL_FILE);
        assert_eq!(fs::read(&destination).unwrap(), b"GGUFtest");
        assert!(!installed.join(format!("{MODEL_FILE}.partial")).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(destination).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_import_while_a_model_is_leased() {
        let root = temp_root("leased");
        let store = CleanupModelStore::new(root.clone());
        store.inner.lock().unwrap().leases = 1;
        let error = store
            .import_artifact(
                Path::new("unused"),
                ArtifactSpec {
                    sha256: "",
                    size: 0,
                },
            )
            .unwrap_err();
        assert!(error.contains("in use"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn lease_rejects_same_size_tampering() {
        let root = temp_root("tamper");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let bytes = b"GGUFtest";
        let digest = Box::leak(
            format!("{:x}", Sha256::digest(bytes)).into_boxed_str(),
        );
        let store = CleanupModelStore::new(root.clone());
        fs::write(store.model_path(), b"GGUFevil").unwrap();
        let error = store.lease_artifact(
            MODEL_ID,
            ArtifactSpec {
                sha256: digest,
                size: bytes.len() as u64,
            },
        ).unwrap_err();
        assert!(error.contains("SHA-256 mismatch"));
        assert_eq!(store.inner.lock().unwrap().leases, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verified_lease_blocks_concurrent_import_until_drop() {
        let root = temp_root("lease-import");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let bytes = b"GGUFtest";
        let digest = Box::leak(
            format!("{:x}", Sha256::digest(bytes)).into_boxed_str(),
        );
        let artifact = ArtifactSpec {
            sha256: digest,
            size: bytes.len() as u64,
        };
        let store = CleanupModelStore::new(root.clone());
        fs::write(store.model_path(), bytes).unwrap();
        let first = store.lease_artifact(MODEL_ID, artifact).unwrap();
        let queued = store.lease_artifact(MODEL_ID, artifact).unwrap();
        assert!(store.import_artifact(&store.model_path(), artifact)
            .unwrap_err()
            .contains("in use"));
        drop(first);
        assert!(store.import_artifact(&store.model_path(), artifact)
            .unwrap_err()
            .contains("in use"));
        drop(queued);
        assert!(store.import_artifact(&store.model_path(), artifact).is_ok());
        let _ = fs::remove_dir_all(root);
    }
}
