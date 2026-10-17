//! Model download, cancel and failure cleanup for `ModelStore` (split out of
//! store.rs). A failed or cancelled attempt never leaves a `.partial` behind.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use super::verify::Integrity;
use super::{DownloadProgressDto, Inflight, ModelStore};
use crate::stt::catalog::{self, ModelSpec};
use crate::stt::error::SttErrorDto;

impl ModelStore {
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
    pub fn download(&self, app: &AppHandle, model_id: &str) -> Result<(), SttErrorDto> {
        self.download_with_sink(model_id, |progress| {
            let _ = app.emit("stt:download-progress", progress);
        })
    }

    /// Core download with a progress sink (used by IPC and unit tests).
    pub fn download_with_sink<F>(&self, model_id: &str, on_progress: F) -> Result<(), SttErrorDto>
    where
        F: FnMut(DownloadProgressDto),
    {
        let spec = catalog::find(model_id).ok_or_else(|| {
            SttErrorDto::new("download-failed", format!("Unknown model: {model_id}"))
        })?;
        self.download_spec_with_sink(spec, spec.url, on_progress)
    }

    pub(super) fn download_spec_with_sink<F>(
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

        // A verified, renamed model is never deleted by a late cancel (BUS-35):
        // Ok means the final file exists and matched its SHA-256.
        if result.is_ok() {
            return result;
        }

        if cancel.load(Ordering::Acquire) {
            // Only the partial is ours to remove; the final path is untouched.
            let _ = fs::remove_file(self.model_path(spec).with_extension("bin.partial"));
            return Err(SttErrorDto::new(
                "cancelled",
                format!("Download cancelled: {}", spec.id),
            ));
        }

        // A failed attempt leaves nothing behind, so Retry starts clean and
        // the UI's "Nothing was saved." stays true.
        let _ = fs::remove_file(self.model_path(spec).with_extension("bin.partial"));
        result
    }

    pub(super) fn fetch_to_model_path<F>(
        &self,
        spec: &ModelSpec,
        url: &str,
        cancel: &AtomicBool,
        on_progress: &mut F,
    ) -> Result<(), SttErrorDto>
    where
        F: FnMut(DownloadProgressDto),
    {
        fs::create_dir_all(&self.root)
            .map_err(|e| SttErrorDto::new("download-failed", format!("create models dir: {e}")))?;

        let dest = self.model_path(spec);
        let tmp = dest.with_extension("bin.partial");

        let response = ureq::get(url)
            .call()
            .map_err(|e| SttErrorDto::new("download-failed", format!("request failed: {e}")))?;

        let declared = response
            .header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok());
        let total = declared.unwrap_or(spec.size_bytes);

        let mut reader = response.into_reader();
        let mut file = File::create(&tmp)
            .map_err(|e| SttErrorDto::new("download-failed", format!("create temp file: {e}")))?;

        let mut buf = [0u8; 64 * 1024];
        let mut integrity = Integrity::default();
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
            let n = reader
                .read(&mut buf)
                .map_err(|e| SttErrorDto::new("download-failed", format!("read failed: {e}")))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .map_err(|e| SttErrorDto::new("download-failed", format!("write failed: {e}")))?;
            integrity.update(&buf[..n]);
            let received = integrity.received();
            // Intermediate progress only — never claim ratio 1.0 until the
            // file is renamed into place (completion is the Ok return + final emit).
            if received - last_emit >= 256 * 1024 || received == total {
                last_emit = received;
                let ratio = if total == 0 {
                    0.0
                } else {
                    (received as f64 / total as f64).clamp(0.0, 0.999)
                };
                on_progress(DownloadProgressDto {
                    bytes_received: received,
                    bytes_total: total,
                    model_id: spec.id.to_owned(),
                    ratio,
                });
            }
        }

        file.flush()
            .map_err(|e| SttErrorDto::new("download-failed", format!("flush failed: {e}")))?;
        // Durable before the rename, so a crash cannot leave a short "verified" file.
        file.sync_all()
            .map_err(|e| SttErrorDto::new("download-failed", format!("sync failed: {e}")))?;
        drop(file);

        let received = integrity.received();
        // Short read or wrong bytes: never rename; the caller removes the partial.
        integrity.finish(spec, declared)?;

        if cancel.load(Ordering::Acquire) {
            let _ = fs::remove_file(&tmp);
            return Err(SttErrorDto::new(
                "cancelled",
                format!("Download cancelled: {}", spec.id),
            ));
        }

        fs::rename(&tmp, &dest)
            .map_err(|e| SttErrorDto::new("download-failed", format!("finalize failed: {e}")))?;
        // Bytes were just hashed: record it so the file is never re-hashed.
        super::existing::write_marker(spec, &dest);
        self.set_verdict(spec, super::existing::Verdict::Verified);

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
