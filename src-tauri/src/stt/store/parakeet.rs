//! Complete-set store for the pinned FluidAudio local-only loader.
//! All blocking download work is called by the command's spawn_blocking.
use super::{DownloadProgressDto, Inflight, ModelInfoDto, ModelStore};
use crate::model_fetch::{self, FetchError};
use crate::stt::{
    error::SttErrorDto,
    parakeet_catalog::{self, ParakeetFile, ParakeetModelSpec},
};
use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);
struct Stage(PathBuf);
impl Stage {
    fn create(path: PathBuf) -> std::io::Result<Self> {
        // Cleanup ownership starts only after an exclusive successful claim.
        fs::create_dir(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fetch_error(error: FetchError) -> SttErrorDto {
    match error {
        FetchError::Cancelled => SttErrorDto::new("cancelled", "Model download cancelled."),
        FetchError::HashMismatch { .. } | FetchError::SizeMismatch { .. } => SttErrorDto::new(
            "download-corrupted",
            "Download was damaged. Nothing was saved.",
        ),
        _ => SttErrorDto::new(
            "download-failed",
            "Could not download the complete model set. Try again.",
        ),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn failed_stage_claim_never_deletes_preexisting_directory() {
        let (_, dir) = super::super::tests::temp_store("parakeet-stage-collision");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("prior"), b"retained").unwrap();
        assert!(super::Stage::create(dir.clone()).is_err());
        assert_eq!(std::fs::read(dir.join("prior")).unwrap(), b"retained");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

impl ModelStore {
    pub(super) fn download_parakeet_spec<U, F>(
        &self,
        agent: &ureq::Agent,
        spec: &ParakeetModelSpec,
        url: U,
        mut on_progress: F,
    ) -> Result<(), SttErrorDto>
    where
        U: Fn(&ParakeetFile) -> String,
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
        let result = (|| {
            fs::create_dir_all(&self.root)
                .map_err(|_| fetch_error(FetchError::Io(String::new())))?;
            let suffix = format!(
                "{}-{}",
                std::process::id(),
                NEXT_STAGE.fetch_add(1, Ordering::Relaxed)
            );
            let stage = Stage::create(self.root.join(format!(".{}.staging-{suffix}", spec.id)))
                .map_err(|_| fetch_error(FetchError::Io(String::new())))?;
            let mut completed = 0;
            for file in spec.files {
                if cancel.load(Ordering::Acquire) {
                    return Err(fetch_error(FetchError::Cancelled));
                }
                model_fetch::fetch_verified(
                    agent,
                    &url(file),
                    &stage.0.join(file.path),
                    &file.artifact(),
                    &cancel,
                    |received, _| {
                        let received = completed + received;
                        on_progress(DownloadProgressDto {
                            model_id: spec.id.to_owned(),
                            bytes_received: received,
                            bytes_total: spec.size_bytes,
                            ratio: (received as f64 / spec.size_bytes as f64).clamp(0.0, 0.999),
                        });
                    },
                )
                .map_err(fetch_error)?;
                completed += file.size_bytes;
            }
            let verified = super::parakeet_verify::verify_staged(spec, &stage.0, &cancel)
                .map_err(fetch_error)?;
            // Serialize cancellation with publication: cancellation before this lock wins;
            // after publication it is an idle cancel and must never delete the final set.
            let mut inflight = self.inflight.lock().unwrap();
            if cancel.load(Ordering::Acquire) {
                return Err(fetch_error(FetchError::Cancelled));
            }
            let dest = self.root.join(spec.id);
            let backup = self.root.join(format!(".{}.previous-{suffix}", spec.id));
            let prior = fs::symlink_metadata(&dest).is_ok();
            if prior {
                fs::rename(&dest, &backup)
                    .map_err(|_| fetch_error(FetchError::Io(String::new())))?;
            }
            if fs::rename(&stage.0, &dest).is_err() {
                if prior {
                    let _ = fs::rename(&backup, &dest);
                }
                return Err(fetch_error(FetchError::Io(String::new())));
            }
            // Prior sets are intentionally retained, never silently repaired/deleted.
            if verified.verdict(spec, &dest) != Some(true) {
                let _ = fs::rename(&dest, &stage.0);
                if prior {
                    let _ = fs::rename(&backup, &dest);
                }
                return Err(SttErrorDto::new(
                    "download-corrupted",
                    "Model set changed during verification. Nothing was saved.",
                ));
            }
            self.parakeet_verified
                .lock()
                .unwrap()
                .insert(spec.id, verified);
            *inflight = None;
            drop(inflight);
            on_progress(DownloadProgressDto {
                model_id: spec.id.to_owned(),
                bytes_received: spec.size_bytes,
                bytes_total: spec.size_bytes,
                ratio: 1.0,
            });
            self.notify_models_changed();
            Ok(())
        })();
        // Do not clear a successor's slot: final progress callbacks may start another download.
        let mut inflight = self.inflight.lock().unwrap();
        if inflight
            .as_ref()
            .is_some_and(|(_, current)| Arc::ptr_eq(&current.cancel, &cancel))
        {
            *inflight = None;
        }
        result
    }
    pub(super) fn parakeet_info(&self, spec: &ParakeetModelSpec) -> ModelInfoDto {
        let supported = parakeet_catalog::is_supported();
        let status = if self.is_downloading(spec.id) {
            "downloading"
        } else {
            match self.parakeet_usable(spec) {
                Some(true) => "available",
                Some(false) => "failed",
                None => "missing",
            }
        };
        ModelInfoDto {
            id: spec.id.to_owned(),
            label: spec.label.to_owned(),
            size_bytes: spec.size_bytes,
            status: status.to_owned(),
            failure_reason: (status == "failed").then(|| "damaged".to_owned()),
            supported,
            unavailable_reason: (!supported)
                .then(|| parakeet_catalog::UNAVAILABLE_REASON.to_owned()),
        }
    }
    pub(super) fn parakeet_resolved(
        &self,
        spec: &ParakeetModelSpec,
    ) -> Result<PathBuf, SttErrorDto> {
        if !parakeet_catalog::is_supported() {
            return Err(SttErrorDto::new(
                "engine-unavailable",
                parakeet_catalog::UNAVAILABLE_REASON,
            ));
        }
        match self.parakeet_usable(spec) {
            Some(true) => Ok(self.root.join(spec.id)),
            Some(false) => Err(SttErrorDto::new(
                "model-missing",
                super::existing::DAMAGED_MESSAGE,
            )),
            None => Err(SttErrorDto::new(
                "model-missing",
                "Complete model set is not downloaded.",
            )),
        }
    }
}
