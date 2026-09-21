//! Explicit model download / cancel store.
//!
//! **No silent download:** constructing `ModelStore` never fetches bytes.
//! Only `download` (after user intent) performs network I/O.
//!
//! Blocking I/O is intended to run off the Tauri command/main thread
//! (see `stt_download_model` async + `spawn_blocking`).

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

    /// Cancel an in-flight download. Safe when nothing is downloading
    /// (including when the model is already present) — returns Ok.
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
    /// Emits `stt:download-progress` while bytes arrive; returns only after
    /// the file is finalized on disk (or cancel / error).
    pub fn download(
        &self,
        app: &AppHandle,
        model_id: &str,
    ) -> Result<(), SttErrorDto> {
        self.download_with_sink(model_id, |progress| {
            let _ = app.emit("stt:download-progress", progress);
        })
    }

    /// Core download with a progress sink (used by IPC and unit tests).
    pub fn download_with_sink<F>(
        &self,
        model_id: &str,
        on_progress: F,
    ) -> Result<(), SttErrorDto>
    where
        F: FnMut(DownloadProgressDto),
    {
        let spec = catalog::find(model_id).ok_or_else(|| {
            SttErrorDto::new("download-failed", format!("Unknown model: {model_id}"))
        })?;
        self.download_spec_with_sink(spec, spec.url, on_progress)
    }

    fn download_spec_with_sink<F>(
        &self,
        spec: &ModelSpec,
        url: &str,
        mut on_progress: F,
    ) -> Result<(), SttErrorDto>
    where
        F: FnMut(DownloadProgressDto),
    {
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

        let result = self.fetch_to_model_path(spec, url, &cancel, &mut on_progress);

        *self.inflight.lock().unwrap() = None;

        if cancel.load(Ordering::Acquire) {
            let partial = self.model_path(spec);
            let _ = fs::remove_file(&partial);
            let tmp = partial.with_extension("bin.partial");
            let _ = fs::remove_file(tmp);
            return Err(SttErrorDto::new(
                "cancelled",
                format!("Download cancelled: {}", spec.id),
            ));
        }

        result
    }

    fn fetch_to_model_path<F>(
        &self,
        spec: &ModelSpec,
        url: &str,
        cancel: &AtomicBool,
        on_progress: &mut F,
    ) -> Result<(), SttErrorDto>
    where
        F: FnMut(DownloadProgressDto),
    {
        fs::create_dir_all(&self.root).map_err(|e| {
            SttErrorDto::new("download-failed", format!("create models dir: {e}"))
        })?;

        let dest = self.model_path(spec);
        let tmp = dest.with_extension("bin.partial");

        let response = ureq::get(url).call().map_err(|e| {
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
            // Intermediate progress only — never claim ratio 1.0 until the
            // file is renamed into place (completion is the Ok return + final emit).
            if received - last_emit >= 256 * 1024 || received == total {
                last_emit = received;
                let ratio = if total == 0 {
                    0.0
                } else {
                    ((received as f64 / total as f64).min(0.999)).max(0.0)
                };
                on_progress(DownloadProgressDto {
                    bytes_received: received,
                    bytes_total: total,
                    model_id: spec.id.to_owned(),
                    ratio,
                });
            }
        }

        file.flush().map_err(|e| {
            SttErrorDto::new("download-failed", format!("flush failed: {e}"))
        })?;
        drop(file);

        if cancel.load(Ordering::Acquire) {
            let _ = fs::remove_file(&tmp);
            return Err(SttErrorDto::new(
                "cancelled",
                format!("Download cancelled: {}", spec.id),
            ));
        }

        fs::rename(&tmp, &dest).map_err(|e| {
            SttErrorDto::new("download-failed", format!("finalize failed: {e}"))
        })?;

        // Only after the destination file exists do we report completion.
        debug_assert!(dest.is_file());
        on_progress(DownloadProgressDto {
            bytes_received: total.max(received),
            bytes_total: total.max(received),
            model_id: spec.id.to_owned(),
            ratio: 1.0,
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::io::{Read as IoRead, Write as IoWrite};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    fn temp_store(label: &str) -> (ModelStore, PathBuf) {
        let dir = env::temp_dir().join(format!(
            "voxloom-stt-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        (ModelStore::new(dir.clone()), dir)
    }

    /// Serve `body` over HTTP/1.1 on a random localhost port. Optional delay
    /// before each chunk so cancel races can observe inflight state.
    fn serve_bytes(body: Vec<u8>, chunk_delay: Option<Duration>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut req = [0u8; 4096];
            let _ = stream.read(&mut req);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            for chunk in body.chunks(1024) {
                if let Some(d) = chunk_delay {
                    thread::sleep(d);
                }
                if stream.write_all(chunk).is_err() {
                    break;
                }
            }
        });
        format!("http://127.0.0.1:{port}/model.bin")
    }

    #[test]
    fn construct_does_not_download_or_create_network() {
        let (store, dir) = temp_store("construct");
        let list = store.list();
        assert!(!list.is_empty());
        assert!(list.iter().all(|m| m.status == "missing"));
        // Root may not even exist yet — download creates it.
        assert!(!dir.join("ggml-tiny.en.bin").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_model_status_is_none() {
        let (store, dir) = temp_store("unknown");
        assert!(store.status("nope").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_when_idle_or_already_present_is_ok() {
        let (store, dir) = temp_store("cancel-idle");
        assert!(store.cancel("whisper-tiny.en").is_ok());

        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ggml-tiny.en.bin"), b"fake").unwrap();
        assert_eq!(
            store.status("whisper-tiny.en").unwrap().status,
            "available"
        );
        assert!(store.cancel("whisper-tiny.en").is_ok());
        assert!(dir.join("ggml-tiny.en.bin").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_does_not_claim_complete_before_file_finalized() {
        let body = vec![0xABu8; 8 * 1024];
        let url = serve_bytes(body.clone(), None);
        let (store, dir) = temp_store("complete-order");
        let spec = catalog::find("whisper-tiny.en").unwrap();

        let events: Arc<Mutex<Vec<(f64, bool)>>> = Arc::new(Mutex::new(Vec::new()));
        let events2 = Arc::clone(&events);
        let dest = store.model_path(spec);

        let result = store.download_spec_with_sink(spec, &url, |p| {
            let exists = dest.is_file();
            events2.lock().unwrap().push((p.ratio, exists));
        });

        assert!(result.is_ok(), "download should succeed: {result:?}");
        assert!(dest.is_file(), "final model file must exist after Ok");
        let written = fs::read(&dest).unwrap();
        assert_eq!(written, body);

        let snapshot = events.lock().unwrap().clone();
        assert!(
            !snapshot.is_empty(),
            "expected at least one progress event"
        );
        // No ratio==1.0 event may fire before the destination file exists.
        for (ratio, exists) in &snapshot {
            if *ratio >= 1.0 {
                assert!(
                    *exists,
                    "ratio 1.0 must not emit before destination file exists"
                );
            }
        }
        let last = snapshot.last().unwrap();
        assert!((last.0 - 1.0).abs() < f64::EPSILON);
        assert!(last.1);

        // Status flips to available only after completion (command returned).
        assert_eq!(
            store.status("whisper-tiny.en").unwrap().status,
            "available"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_during_download_removes_partial_and_errors() {
        let body = vec![0xCDu8; 64 * 1024];
        let url = serve_bytes(body, Some(Duration::from_millis(30)));
        let (store, dir) = temp_store("cancel-inflight");
        let store = Arc::new(store);
        let spec = catalog::find("whisper-base.en").unwrap();

        let store_cancel = Arc::clone(&store);
        thread::spawn(move || {
            // Wait until inflight is registered, then cancel.
            for _ in 0..200 {
                if store_cancel.is_downloading("whisper-base.en") {
                    let _ = store_cancel.cancel("whisper-base.en");
                    return;
                }
                thread::sleep(Duration::from_millis(5));
            }
            let _ = store_cancel.cancel("whisper-base.en");
        });

        let result = store.download_spec_with_sink(spec, &url, |_| {});
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, "cancelled");
        assert!(
            !dir.join("ggml-base.en.bin").exists(),
            "cancelled download must not leave a final model file"
        );
        assert!(
            !dir.join("ggml-base.en.bin.partial").exists(),
            "partial file should be cleaned up"
        );
        assert_eq!(
            store.status("whisper-base.en").unwrap().status,
            "missing"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_download_while_inflight_fails() {
        let (store, dir) = temp_store("double");
        {
            let mut guard = store.inflight.lock().unwrap();
            *guard = Some((
                "whisper-tiny.en".to_owned(),
                Inflight {
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            ));
        }
        let err = store
            .download_with_sink("whisper-base.en", |_| {})
            .unwrap_err();
        assert_eq!(err.code, "download-failed");
        *store.inflight.lock().unwrap() = None;
        let _ = fs::remove_dir_all(&dir);
    }
}
