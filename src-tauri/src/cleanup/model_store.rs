use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

use super::artifact::{
    copy_private, open_regular, validate as validate_artifact, validate_file,
    ArtifactSpec,
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
                .map_err(|error| {
                    format!("sync cleanup model directory: {error}")
                })
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
        fs::create_dir_all(&self.root).map_err(|error| {
            format!("create cleanup model directory: {error}")
        })?;
        let destination = self.model_path();
        if validate_artifact(&destination, artifact).is_ok() {
            // Also retry durability after a prior post-rename sync failure.
            return sync_parent(&self.root);
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
                fs::rename(&temporary, &destination).map_err(|error| {
                    format!("finalize cleanup model: {error}")
                })?;
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
    fn sync_failure_is_reported_after_rename_and_retry_syncs_existing_model() {
        let root = temp_root("directory-sync");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.gguf");
        fs::write(&source, b"GGUFtest").unwrap();
        let spec = ArtifactSpec {
            sha256: Box::leak(
                format!("{:x}", Sha256::digest(b"GGUFtest")).into_boxed_str(),
            ),
            size: 8,
        };
        let installed = root.join("installed");
        let store = CleanupModelStore::new(installed.clone());
        let error = store
            .import_artifact_with_sync(&source, spec, |parent| {
                assert_eq!(parent, installed);
                assert_eq!(
                    fs::read(parent.join(MODEL_FILE)).unwrap(),
                    b"GGUFtest"
                );
                assert!(!parent.join(format!("{MODEL_FILE}.partial")).exists());
                Err("directory sync failed".into())
            })
            .unwrap_err();
        assert_eq!(error, "directory sync failed");
        // The valid renamed file remains, but success is not claimed. Neither
        // the import guard nor retry may suppress another directory sync.
        let mut synced = false;
        store
            .import_artifact_with_sync(&source, spec, |parent| {
                assert_eq!(parent, installed);
                synced = true;
                Ok(())
            })
            .unwrap();
        assert!(synced);
        assert!(store.lease_artifact(MODEL_ID, spec).is_ok());
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
    fn admission_opens_without_hashing_the_model() {
        let root = temp_root("cheap-admission");
        fs::create_dir_all(&root).unwrap();
        let store = CleanupModelStore::new(root);
        fs::write(store.model_path(), b"GGUFevil").unwrap();
        // Admission is only a reservation. Full verification belongs immediately
        // before inference, on this same descriptor, not on the microphone path.
        let lease = store.lease_artifact(
            MODEL_ID,
            ArtifactSpec {
                sha256: "not-the-digest",
                size: 8,
            },
        );
        assert!(lease.is_ok(), "admission must not hash: {lease:?}");
    }

    #[test]
    fn lease_rejects_same_size_tampering() {
        let root = temp_root("tamper");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let bytes = b"GGUFtest";
        let digest =
            Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
        let store = CleanupModelStore::new(root.clone());
        fs::write(store.model_path(), b"GGUFevil").unwrap();
        let mut lease = store
            .lease_artifact(
                MODEL_ID,
                ArtifactSpec {
                    sha256: digest,
                    size: bytes.len() as u64,
                },
            )
            .unwrap();
        let error = lease.verify().unwrap_err();
        assert!(error.contains("SHA-256 mismatch"));
        assert_eq!(store.inner.lock().unwrap().leases, 1);
        drop(lease);
        assert_eq!(store.inner.lock().unwrap().leases, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounds_descriptors_even_while_retired_acquisitions_are_finishing() {
        let root = temp_root("descriptor-capacity");
        fs::create_dir_all(&root).unwrap();
        let store = CleanupModelStore::new(root);
        fs::write(store.model_path(), b"GGUFtest").unwrap();
        let first = store.lease(MODEL_ID).unwrap();
        let second = store.lease(MODEL_ID).unwrap();
        assert!(store.lease(MODEL_ID).is_err());
        drop(first);
        assert!(store.lease(MODEL_ID).is_ok());
        drop(second);
    }

    #[test]
    fn verification_uses_the_reserved_descriptor_without_store_lock() {
        let root = temp_root("descriptor-verification");
        fs::create_dir_all(&root).unwrap();
        let bytes = b"GGUFtest";
        let digest =
            Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
        let store = CleanupModelStore::new(root.clone());
        fs::write(store.model_path(), bytes).unwrap();
        let mut lease = store
            .lease_artifact(
                MODEL_ID,
                ArtifactSpec {
                    sha256: digest,
                    size: 8,
                },
            )
            .unwrap();
        fs::rename(store.model_path(), root.join("original.gguf")).unwrap();
        fs::write(store.model_path(), b"GGUFevil").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let lock = store.inner.lock().unwrap();
        let verifier = std::thread::spawn(move || {
            sender.send(lease.verify()).unwrap();
            lease
        });
        let result = receiver.recv_timeout(std::time::Duration::from_secs(2));
        drop(lock);
        let mut lease = verifier.join().unwrap();
        assert!(result.unwrap().is_ok());
        // Mutation of the held descriptor is still detected on re-verification.
        fs::write(root.join("original.gguf"), b"GGUFevil").unwrap();
        assert!(lease.verify().unwrap_err().contains("SHA-256 mismatch"));
        drop(lease);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verified_lease_blocks_concurrent_import_until_drop() {
        let root = temp_root("lease-import");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let bytes = b"GGUFtest";
        let digest =
            Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
        let artifact = ArtifactSpec {
            sha256: digest,
            size: bytes.len() as u64,
        };
        let store = CleanupModelStore::new(root.clone());
        fs::write(store.model_path(), bytes).unwrap();
        let first = store.lease_artifact(MODEL_ID, artifact).unwrap();
        let queued = store.lease_artifact(MODEL_ID, artifact).unwrap();
        assert!(store
            .import_artifact(&store.model_path(), artifact)
            .unwrap_err()
            .contains("in use"));
        drop(first);
        assert!(store
            .import_artifact(&store.model_path(), artifact)
            .unwrap_err()
            .contains("in use"));
        drop(queued);
        assert!(store.import_artifact(&store.model_path(), artifact).is_ok());
        let _ = fs::remove_dir_all(root);
    }
}
