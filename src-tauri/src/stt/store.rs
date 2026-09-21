//! Explicit model download / cancel store.
//!
//! **No silent download:** constructing `ModelStore` never fetches bytes.
//! Only `download` (after user intent) performs network I/O.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::catalog::{self, ModelSpec};
use super::error::SttErrorDto;

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
}

impl ModelStore {
    /// Create a store rooted at `app_data_dir/models`. Does **not** download.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            inflight: Mutex::new(None),
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
            "available"
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
        Ok(path)
    }

    fn is_downloading(&self, model_id: &str) -> bool {
        self.inflight
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(id, _)| id == model_id)
    }

    pub fn cancel(&self, model_id: &str) -> Result<(), SttErrorDto> {
        let spec = catalog::find(model_id).ok_or_else(|| {
            SttErrorDto::new("download-failed", format!("Unknown model: {model_id}"))
        })?;
        let guard = self.inflight.lock().unwrap();
        if let Some((id, inflight)) = guard.as_ref() {
            if id == spec.id {
                inflight.cancel.store(true, Ordering::Release);
                return Ok(());
            }
        }
        Ok(())
    }

    /// Explicit user-triggered download. Never call from constructors.
    pub fn download(
        &self,
        app: &AppHandle,
        model_id: &str,
    ) -> Result<(), SttErrorDto> {
        let spec = catalog::find(model_id).ok_or_else(|| {
            SttErrorDto::new("download-failed", format!("Unknown model: {model_id}"))
        })?;

        {
            let mut guard = self.inflight.lock().unwrap();
            if guard.is_some() {
                return Err(SttErrorDto::new(
                    "download-failed",
                    "Another model download is already in progress",
                ));
            }
            *guard = Some((
                spec.id.to_owned(),
                Inflight {
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            ));
        }

        let cancel = self
            .inflight
            .lock()
            .unwrap()
            .as_ref()
            .expect("inflight just set")
            .1
            .cancel
            .clone();

        let result = self.download_inner(app, spec, &cancel);

        *self.inflight.lock().unwrap() = None;

        if cancel.load(Ordering::Acquire) {
            let partial = self.model_path(spec);
            let _ = fs::remove_file(partial);
            return Err(SttErrorDto::new(
                "cancelled",
                format!("Download cancelled: {}", spec.id),
            ));
        }

        result
    }

    fn download_inner(
        &self,
        app: &AppHandle,
        spec: &ModelSpec,
        cancel: &AtomicBool,
    ) -> Result<(), SttErrorDto> {
        fs::create_dir_all(&self.root).map_err(|e| {
            SttErrorDto::new("download-failed", format!("create models dir: {e}"))
        })?;

        let dest = self.model_path(spec);
        let tmp = dest.with_extension("bin.partial");

        let response = ureq::get(spec.url).call().map_err(|e| {
            SttErrorDto::new("download-failed", format!("request failed: {e}"))
        })?;

        let total = response
            .header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(spec.size_bytes);

        let mut reader = response.into_reader();
        let mut file = File::create(&tmp).map_err(|e| {
            SttErrorDto::new("download-failed", format!("create temp file: {e}"))
        })?;

        let mut buf = [0u8; 64 * 1024];
        let mut received: u64 = 0;
        let mut last_emit = 0u64;

        loop {
            if cancel.load(Ordering::Acquire) {
                drop(file);
                let _ = fs::remove_file(&tmp);
                return Err(SttErrorDto::new(
                    "cancelled",
                    format!("Download cancelled: {}", spec.id),
                ));
            }
            let n = reader.read(&mut buf).map_err(|e| {
                SttErrorDto::new("download-failed", format!("read failed: {e}"))
            })?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| {
                SttErrorDto::new("download-failed", format!("write failed: {e}"))
            })?;
            received += n as u64;
            if received - last_emit >= 256 * 1024 || received == total {
                last_emit = received;
                let ratio = if total == 0 {
                    0.0
                } else {
                    (received as f64 / total as f64).min(1.0)
                };
                let _ = app.emit(
                    "stt:download-progress",
                    DownloadProgressDto {
                        bytes_received: received,
                        bytes_total: total,
                        model_id: spec.id.to_owned(),
                        ratio,
                    },
                );
            }
        }

        file.flush().map_err(|e| {
            SttErrorDto::new("download-failed", format!("flush failed: {e}"))
        })?;
        drop(file);
        fs::rename(&tmp, &dest).map_err(|e| {
            SttErrorDto::new("download-failed", format!("finalize failed: {e}"))
        })?;

        let _ = app.emit(
            "stt:download-progress",
            DownloadProgressDto {
                bytes_received: total,
                bytes_total: total,
                model_id: spec.id.to_owned(),
                ratio: 1.0,
            },
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn construct_does_not_download_or_create_network() {
        let dir = env::temp_dir().join(format!(
            "voxloom-stt-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let store = ModelStore::new(dir.clone());
        let list = store.list();
        assert!(!list.is_empty());
        assert!(list.iter().all(|m| m.status == "missing"));
        // Root may not even exist yet — download creates it.
        assert!(!dir.join("ggml-tiny.en.bin").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_model_status_is_none() {
        let dir = env::temp_dir().join("voxloom-stt-unknown");
        let store = ModelStore::new(dir);
        assert!(store.status("nope").is_none());
    }
}
