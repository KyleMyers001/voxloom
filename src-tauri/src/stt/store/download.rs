//! Model download, cancel and failure cleanup for `ModelStore` (split out of
//! store.rs). Bytes are fetched and verified by the shared
//! `crate::model_fetch` core: the file is renamed into place only after its
//! exact size and SHA-256 match the pinned catalog entry. A failed, cancelled
//! or mismatched attempt never leaves a `.partial` (or a final file) behind.

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use super::{DownloadProgressDto, Inflight, ModelStore};
use crate::model_fetch::{self, FetchError};
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
    /// the file is verified and finalized on disk (or cancel / error).
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
        self.download_spec_with_sink(model_fetch::shared_agent(), spec, spec.url, on_progress)
    }

    pub(super) fn download_spec_with_sink<F>(
        &self,
        agent: &ureq::Agent,
        spec: &ModelSpec,
        url: &str,
        mut on_progress: F,
    ) -> Result<(), SttErrorDto>
    where
        F: FnMut(DownloadProgressDto),
    {
        let cancel = {
            let mut guard = self.inflight.lock().unwrap();
            if guard.is_some() {
                return Err(SttErrorDto::new(
                    "download-failed",
                    "Another model download is already in progress",
                ));
            }
            let cancel = Arc::new(AtomicBool::new(false));
            *guard = Some((
                spec.id.to_owned(),
                Inflight {
                    cancel: Arc::clone(&cancel),
                },
            ));
            cancel
        };

        let dest = self.model_path(spec);
        let result = model_fetch::fetch_verified(
            agent,
            url,
            &dest,
            &spec.artifact(),
            &cancel,
            |received, total| {
                // Intermediate progress only — never claim ratio 1.0 until the
                // file is verified and renamed into place.
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
            },
        );

        *self.inflight.lock().unwrap() = None;

        if cancel.load(Ordering::Acquire) {
            // Cancel wins even if the last bytes landed: nothing stays behind.
            let _ = fs::remove_file(&dest);
            let _ = fs::remove_file(model_fetch::partial_path(&dest));
            return Err(cancelled(spec));
        }

        result.map_err(|e| fetch_error(spec, e))?;

        // Only after the verified destination file exists do we report completion.
        debug_assert!(dest.is_file());
        on_progress(DownloadProgressDto {
            bytes_received: spec.size_bytes,
            bytes_total: spec.size_bytes,
            model_id: spec.id.to_owned(),
            ratio: 1.0,
        });
        Ok(())
    }
}

fn cancelled(spec: &ModelSpec) -> SttErrorDto {
    SttErrorDto::new("cancelled", format!("Download cancelled: {}", spec.id))
}

/// Map a shared fetch failure to the existing `download-failed` / `cancelled`
/// codes so the UI's retry flow is unchanged; mismatches get a clear message.
fn fetch_error(spec: &ModelSpec, err: FetchError) -> SttErrorDto {
    match err {
        FetchError::Cancelled => cancelled(spec),
        e @ (FetchError::SizeMismatch { .. } | FetchError::HashMismatch { .. }) => SttErrorDto::new(
            "download-failed",
            format!(
                "Downloaded {} did not match the expected file ({e}). Nothing was saved; try again.",
                spec.id
            ),
        ),
        FetchError::Network(msg) | FetchError::Io(msg) => SttErrorDto::new("download-failed", msg),
    }
}
