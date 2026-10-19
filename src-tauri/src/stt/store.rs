//! Explicit model download / cancel store.
//!
//! **No silent download:** constructing `ModelStore` never fetches bytes.
//! Only `download` (after user intent) performs network I/O.
//!
//! Blocking I/O is intended to run off the Tauri command/main thread
//! (see `stt_download_model` async + `spawn_blocking`).

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock, Weak};

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
    /// Why a `failed` model failed its on-disk check: `damaged`, `unreadable`
    /// (couldn't open) or `read-failed` (opened, couldn't read).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
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
    /// Models with a background re-check pending or running.
    reverifying: Mutex<existing::PendingSet>,
    /// Self-reference for background re-checks; set by the startup pass.
    this: OnceLock<Weak<ModelStore>>,
    /// Tells Settings → Models to re-list (`stt:models-changed`); set by lib.rs.
    on_models_changed: Mutex<Option<ModelsChanged>>,
}

/// Callback that asks the UI to re-list models.
pub type ModelsChanged = Arc<dyn Fn() + Send + Sync>;

impl ModelStore {
    /// Create a store rooted at `app_data_dir/models`. Does **not** download.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            inflight: Mutex::new(None),
            verdicts: Mutex::new(Default::default()),
            hashing: Mutex::new(()),
            reverifying: Mutex::new(Default::default()),
            this: OnceLock::new(),
            on_models_changed: Mutex::new(None),
        }
    }

    /// Register the "models changed" notifier (lib.rs emits the Tauri event).
    pub fn set_on_models_changed(&self, notify: ModelsChanged) {
        *self.on_models_changed.lock().unwrap() = Some(notify);
    }

    fn notify_models_changed(&self) {
        let notify = self.on_models_changed.lock().unwrap().clone();
        if let Some(notify) = notify {
            notify();
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
        let mut failure_reason = None;
        let status = if self.is_downloading(spec.id) {
            "downloading"
        } else if path.is_file() {
            // Not yet verified (startup hash still running) reads as available
            // and stays usable; only a file the check found damaged or
            // unreadable is failed.
            failure_reason = self
                .current_verdict(spec)
                .and_then(existing::Verdict::failure_reason);
            if failure_reason.is_some() {
                "failed"
            } else {
                "available"
            }
        } else {
            "missing"
        };
        ModelInfoDto {
            id: spec.id.to_owned(),
            label: spec.label.to_owned(),
            size_bytes: spec.size_bytes,
            status: status.to_owned(),
            failure_reason: failure_reason.map(str::to_owned),
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
        // Never hash here: a model still being checked in the background
        // stays usable, so dictation never waits on it; the file is only
        // re-opened cheaply (current_verdict).
        match self
            .current_verdict(spec)
            .and_then(existing::Verdict::refusal)
        {
            Some(message) => Err(SttErrorDto::new("model-missing", message)),
            None => Ok(path),
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
mod recovery_tests;
#[cfg(test)]
mod tests;
