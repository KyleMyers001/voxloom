//! Complete-set store for the pinned FluidAudio local-only loader.
//! All blocking download work is called by the command's spawn_blocking.
use super::{DownloadProgressDto, Inflight, ModelInfoDto, ModelStore};
use crate::model_fetch::{self, FetchError};
use crate::stt::{
    error::SttErrorDto,
    parakeet::ModelDirs,
    parakeet_catalog::{self, ParakeetFile, ParakeetModelSpec},
};
use std::fs;
use std::path::{Path, PathBuf};
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

/// Download leftovers a quit or crash can orphan: `.{id}.staging-*` (before
/// `Stage::drop` runs) and `.{id}.previous-*` (before the backup is removed).
const LEFTOVER_KINDS: [&str; 2] = ["staging-", "previous-"];

/// Remove one entry without following symlinks: a symlink or file is unlinked.
fn remove_entry(path: &Path) {
    let _ = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(_) => return,
    };
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
    /// Download what `spec` still needs: the shared dictionary-boosting set
    /// when it is missing or damaged, then the model set (unless only the
    /// shared set was missing). Progress covers both, under the model's id.
    pub(super) fn download_parakeet_spec<U, F>(
        &self,
        agent: &ureq::Agent,
        spec: &ParakeetModelSpec,
        url: U,
        mut on_progress: F,
    ) -> Result<(), SttErrorDto>
    where
        U: Fn(&ParakeetModelSpec, &ParakeetFile) -> String,
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
            let mut sets = Vec::with_capacity(2);
            if self.parakeet_usable(&self.parakeet_vocabulary) != Some(true) {
                sets.push(self.parakeet_vocabulary);
            }
            if self.parakeet_usable(spec) != Some(true) || sets.is_empty() {
                sets.push(*spec);
            }
            let total: u64 = sets.iter().map(|set| set.size_bytes).sum();
            let mut done = 0;
            for (index, set) in sets.iter().enumerate() {
                let last = index + 1 == sets.len();
                self.fetch_parakeet_set(agent, set, &url, &cancel, last, |received| {
                    let received = done + received;
                    on_progress(DownloadProgressDto {
                        model_id: spec.id.to_owned(),
                        bytes_received: received,
                        bytes_total: total,
                        ratio: (received as f64 / total as f64).clamp(0.0, 0.999),
                    });
                })?;
                done += set.size_bytes;
                if !last {
                    // The other Parakeet model may be usable now.
                    self.notify_models_changed();
                }
            }
            on_progress(DownloadProgressDto {
                model_id: spec.id.to_owned(),
                bytes_received: total,
                bytes_total: total,
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

    /// Stage, verify and publish one complete set. `last` releases the
    /// download slot together with publication.
    fn fetch_parakeet_set<U>(
        &self,
        agent: &ureq::Agent,
        set: &ParakeetModelSpec,
        url: &U,
        cancel: &AtomicBool,
        last: bool,
        mut on_received: impl FnMut(u64),
    ) -> Result<(), SttErrorDto>
    where
        U: Fn(&ParakeetModelSpec, &ParakeetFile) -> String,
    {
        fs::create_dir_all(&self.root).map_err(|_| fetch_error(FetchError::Io(String::new())))?;
        let suffix = format!(
            "{}-{}",
            std::process::id(),
            NEXT_STAGE.fetch_add(1, Ordering::Relaxed)
        );
        let stage = Stage::create(self.root.join(format!(".{}.staging-{suffix}", set.id)))
            .map_err(|_| fetch_error(FetchError::Io(String::new())))?;
        let mut completed = 0;
        for file in set.files {
            if cancel.load(Ordering::Acquire) {
                return Err(fetch_error(FetchError::Cancelled));
            }
            model_fetch::fetch_verified(
                agent,
                &url(set, file),
                &stage.0.join(file.path),
                &file.artifact(),
                cancel,
                |received, _| on_received(completed + received),
            )
            .map_err(fetch_error)?;
            completed += file.size_bytes;
        }
        let verified =
            super::parakeet_verify::verify_staged(set, &stage.0, cancel).map_err(fetch_error)?;
        // Serialize cancellation with publication: cancellation before this lock wins;
        // after publication it is an idle cancel and must never delete the final set.
        let mut inflight = self.inflight.lock().unwrap();
        if cancel.load(Ordering::Acquire) {
            return Err(fetch_error(FetchError::Cancelled));
        }
        let dest = self.root.join(set.id);
        let backup = self.root.join(format!(".{}.previous-{suffix}", set.id));
        let prior = fs::symlink_metadata(&dest).is_ok();
        if prior {
            fs::rename(&dest, &backup).map_err(|_| fetch_error(FetchError::Io(String::new())))?;
        }
        if fs::rename(&stage.0, &dest).is_err() {
            if prior {
                let _ = fs::rename(&backup, &dest);
            }
            return Err(fetch_error(FetchError::Io(String::new())));
        }
        if verified.verdict(set, &dest) != Some(true) {
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
            .insert(set.id, verified);
        if last {
            *inflight = None;
        }
        drop(inflight);
        // The verified replacement is published; the prior set is no longer
        // needed. Failure paths above restore it instead.
        if prior {
            remove_entry(&backup);
        }
        Ok(())
    }

    /// Every Parakeet set on disk: the models and the shared boosting set.
    pub(super) fn parakeet_sets(&self) -> impl Iterator<Item = &ParakeetModelSpec> {
        parakeet_catalog::CATALOG
            .iter()
            .chain(std::iter::once(&self.parakeet_vocabulary))
    }
    /// Startup sweep of orphaned download leftovers for Parakeet set ids (exact
    /// `.{id}.staging-` / `.{id}.previous-` prefixes only). Holding the download
    /// slot skips the sweep while a download is in flight and keeps one from
    /// claiming a stage mid-sweep.
    pub(super) fn remove_parakeet_leftovers(&self) {
        let inflight = self.inflight.lock().unwrap();
        if inflight.is_some() {
            return;
        }
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let leftover = self.parakeet_sets().any(|spec| {
                LEFTOVER_KINDS
                    .iter()
                    .any(|kind| name.starts_with(&format!(".{}.{kind}", spec.id)))
            });
            if leftover {
                remove_entry(&entry.path());
            }
        }
    }
    pub(super) fn parakeet_info(&self, spec: &ParakeetModelSpec) -> ModelInfoDto {
        let supported = parakeet_catalog::is_supported();
        let status = if self.is_downloading(spec.id) {
            "downloading"
        } else {
            match self.parakeet_ready(spec) {
                Some(true) => "available",
                Some(false) => "failed",
                None => "missing",
            }
        };
        ModelInfoDto {
            id: spec.id.to_owned(),
            label: spec.label.to_owned(),
            // A fresh install downloads the shared boosting set too.
            size_bytes: spec.size_bytes + self.parakeet_vocabulary.size_bytes,
            status: status.to_owned(),
            failure_reason: (status == "failed").then(|| "damaged".to_owned()),
            supported,
            unavailable_reason: (!supported)
                .then(|| parakeet_catalog::UNAVAILABLE_REASON.to_owned()),
        }
    }
    /// A model is usable only together with the shared boosting set: while
    /// the model set is usable this is the boosting set's state, so an
    /// install from before boosting reads as missing and Download fetches
    /// only the boosting set. Otherwise it is the model set's own state.
    fn parakeet_ready(&self, spec: &ParakeetModelSpec) -> Option<bool> {
        match self.parakeet_usable(spec) {
            Some(true) => self.parakeet_usable(&self.parakeet_vocabulary),
            other => other,
        }
    }
    pub(super) fn parakeet_resolved(
        &self,
        spec: &ParakeetModelSpec,
    ) -> Result<ModelDirs, SttErrorDto> {
        if !parakeet_catalog::is_supported() {
            return Err(SttErrorDto::new(
                "engine-unavailable",
                parakeet_catalog::UNAVAILABLE_REASON,
            ));
        }
        match self.parakeet_ready(spec) {
            Some(true) => Ok(ModelDirs {
                model: self.root.join(spec.id),
                vocabulary: self.root.join(self.parakeet_vocabulary.id),
            }),
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
