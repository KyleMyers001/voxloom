//! Explicit model download / cancel store.
//!
//! **No silent download:** constructing `ModelStore` never fetches bytes.
//! Only `download` (after user intent) performs network I/O.
//!
//! Blocking I/O is intended to run off the Tauri command/main thread
//! (see `stt_download_model` async + `spawn_blocking`).

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::catalog::{self, ModelSpec};
use super::error::SttErrorDto;

mod download;
mod existing;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfoDto {
    pub id: String,
    pub label: String,
    pub size_bytes: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressDto {
    pub bytes_received: u64,
    pub bytes_total: u64,
    pub model_id: String,
    pub ratio: f64,
}

struct Inflight {
    cancel: Arc<AtomicBool>,
}

pub struct ModelStore {
    root: PathBuf,
    inflight: Mutex<Option<(String, Inflight)>>,
    /// Existing-file verification results (see `existing.rs`).
    verdicts: Mutex<existing::VerdictMap>,
    /// Serializes hashing so a file is never hashed twice concurrently.
    hashing: Mutex<()>,
}

impl ModelStore {
    /// Create a store rooted at `app_data_dir/models`. Does **not** download.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            inflight: Mutex::new(None),
            verdicts: Mutex::new(Default::default()),
            hashing: Mutex::new(()),
        }
    }

    /// Resolve the model directory from the Tauri app handle without downloading.
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app data dir: {e}"))?
            .join("models");
        Ok(Self::new(dir))
    }

    #[allow(dead_code)]
    pub fn models_dir(&self) -> &Path {
        &self.root
    }

    pub fn list(&self) -> Vec<ModelInfoDto> {
        catalog::CATALOG
            .iter()
            .map(|spec| self.info_for(spec))
            .collect()
    }

    pub fn status(&self, model_id: &str) -> Option<ModelInfoDto> {
        catalog::find(model_id).map(|spec| self.info_for(spec))
    }

    fn info_for(&self, spec: &ModelSpec) -> ModelInfoDto {
        let path = self.model_path(spec);
        let status = if self.is_downloading(spec.id) {
            "downloading"
        } else if path.is_file() {
            // Not yet verified (startup hash still running) reads as available
            // and stays usable; only a file the check found damaged or unreadable
            // is failed.
            match self.known_verdict(spec) {
                Some(existing::Verdict::Corrupt | existing::Verdict::Unreadable) => "failed",
                _ => "available",
            }
        } else {
            "missing"
        };
        ModelInfoDto {
            id: spec.id.to_owned(),
            label: spec.label.to_owned(),
            size_bytes: spec.size_bytes,
            status: status.to_owned(),
        }
    }

    fn model_path(&self, spec: &ModelSpec) -> PathBuf {
        self.root.join(spec.filename)
    }

    pub fn resolved_path(&self, model_id: &str) -> Result<PathBuf, SttErrorDto> {
        let spec = catalog::find(model_id).ok_or_else(|| {
            SttErrorDto::new("model-missing", format!("Unknown model: {model_id}"))
        })?;
        let path = self.model_path(spec);
        if !path.is_file() {
            return Err(SttErrorDto::new(
                "model-missing",
                format!(
                    "Model `{model_id}` is not downloaded. Call download after explicit user confirm."
                ),
            ));
        }
        // Never hash here: a model still being checked by the background
        // startup pass stays usable, so dictation never waits on it.
        match self.known_verdict(spec) {
            Some(existing::Verdict::Corrupt) => Err(SttErrorDto::new(
                "model-missing",
                "Model file is damaged. Download it again in Settings.",
            )),
            Some(existing::Verdict::Unreadable) => Err(SttErrorDto::new(
                "model-missing",
                "Couldn't open the model file. Download it again in Settings.",
            )),
            _ => Ok(path),
        }
    }

    fn is_downloading(&self, model_id: &str) -> bool {
        self.inflight
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(id, _)| id == model_id)
    }
}

#[cfg(test)]
mod integrity_tests;
#[cfg(test)]
mod tests;
