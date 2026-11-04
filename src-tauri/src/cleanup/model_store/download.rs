//! One-click download of the pinned cleanup model (BUS-181).
//!
//! Reuses `crate::model_fetch` (HTTPS-only agent, `<file>.partial`, size and
//! SHA-256 check before the atomic rename) under the store's import guard, so
//! a download never overlaps an import or a lease. A failed, cancelled or
//! mismatched download leaves no partial file and never touches an installed
//! model. There is no resume: a retry starts from zero.

use std::fs::{self, File};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::pin::MODEL_URL;
use super::{validate_artifact, ArtifactSpec, CleanupModelStore, ModelStatus, ARTIFACT};
use crate::model_fetch::{self, FetchError, PinnedArtifact};

/// Payload of `cleanup:download-progress`. `ratio` stays below 1.0 until the
/// file is verified and in place.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub bytes_received: u64,
    pub bytes_total: u64,
    pub ratio: f64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DownloadError {
    Cancelled,
    Checksum,
    Failed(String),
}

impl CleanupModelStore {
    /// Blocking: download, verify and install the pinned model.
    pub fn download(
        &self,
        on_progress: impl FnMut(DownloadProgress),
    ) -> Result<ModelStatus, DownloadError> {
        self.download_from(
            model_fetch::shared_agent(),
            MODEL_URL,
            ARTIFACT,
            on_progress,
            sync_dir,
        )?;
        Ok(self.status())
    }

    /// Ask the running download to stop. False when none is running.
    pub fn cancel_download(&self) -> bool {
        match &self.inner.lock().unwrap().download {
            Some(flag) => {
                flag.store(true, Ordering::Release);
                true
            }
            None => false,
        }
    }

    pub(super) fn download_from(
        &self,
        agent: &ureq::Agent,
        url: &str,
        artifact: ArtifactSpec,
        mut on_progress: impl FnMut(DownloadProgress),
        sync_parent: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(), DownloadError> {
        let _guard = self.begin_import().map_err(DownloadError::Failed)?;
        let cancel = Arc::new(AtomicBool::new(false));
        self.inner.lock().unwrap().download = Some(Arc::clone(&cancel));
        let result = self.fetch_into_place(agent, url, artifact, &cancel, &mut on_progress);
        self.inner.lock().unwrap().download = None;
        result?;
        sync_parent(&self.root).map_err(DownloadError::Failed)?;
        self.remember_verified(&self.model_path());
        on_progress(DownloadProgress {
            bytes_received: artifact.size,
            bytes_total: artifact.size,
            ratio: 1.0,
        });
        Ok(())
    }

    fn fetch_into_place(
        &self,
        agent: &ureq::Agent,
        url: &str,
        artifact: ArtifactSpec,
        cancel: &AtomicBool,
        on_progress: &mut impl FnMut(DownloadProgress),
    ) -> Result<(), DownloadError> {
        let destination = self.model_path();
        if validate_artifact(&destination, artifact).is_ok() {
            return Ok(());
        }
        fs::create_dir_all(&self.root).map_err(|error| {
            DownloadError::Failed(format!("create cleanup model directory: {error}"))
        })?;
        let pinned = PinnedArtifact {
            size_bytes: artifact.size,
            sha256: artifact.sha256,
        };
        let fetched =
            model_fetch::fetch_verified(agent, url, &destination, &pinned, cancel, |got, total| {
                on_progress(progress(got, total));
            });
        if cancel.load(Ordering::Acquire) {
            // Cancel wins even if the last bytes landed: nothing stays behind.
            if fetched.is_ok() {
                let _ = fs::remove_file(&destination);
            }
            let _ = fs::remove_file(model_fetch::partial_path(&destination));
            return Err(DownloadError::Cancelled);
        }
        fetched.map_err(|error| match error {
            FetchError::Cancelled => DownloadError::Cancelled,
            FetchError::SizeMismatch { .. } | FetchError::HashMismatch { .. } => {
                DownloadError::Checksum
            }
            FetchError::Network(message) | FetchError::Io(message) => {
                DownloadError::Failed(message)
            }
        })?;
        make_private(&destination).map_err(DownloadError::Failed)
    }
}

fn progress(received: u64, total: u64) -> DownloadProgress {
    let ratio = if total == 0 {
        0.0
    } else {
        (received as f64 / total as f64).clamp(0.0, 0.999)
    };
    DownloadProgress {
        bytes_received: received,
        bytes_total: total,
        ratio,
    }
}

/// Same 0600 mode an imported model gets.
fn make_private(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("protect cleanup model: {error}"))?;
    }
    let _ = path;
    Ok(())
}

fn sync_dir(parent: &Path) -> Result<(), String> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync cleanup model directory: {error}"))
}

#[cfg(all(test, unix))]
#[path = "download_tests.rs"]
mod tests;
