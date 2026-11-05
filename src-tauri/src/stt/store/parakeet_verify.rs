//! Cheap metadata snapshots: resolution/status never read model payloads.
use crate::stt::parakeet_catalog::ParakeetModelSpec;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Snapshot(Vec<Fingerprint>);
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    size: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}
#[derive(Clone)]
pub(super) struct CheckedSet {
    pin: String,
    at: Snapshot,
    valid: bool,
}

pub(super) fn snapshot(spec: &ParakeetModelSpec, dir: &Path) -> Option<Snapshot> {
    // Enumerate only pinned directories (bounded by the manifest), rejecting
    // extra/optional payloads and symlinks at every level, including set root.
    let mut expected = std::collections::BTreeMap::new();
    expected.insert(std::path::PathBuf::new(), None);
    for file in spec.files {
        let path = std::path::PathBuf::from(file.path);
        if path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return None;
        }
        expected.insert(path.clone(), Some(file.size_bytes));
        let mut parent = path.parent();
        while let Some(path) = parent {
            expected.entry(path.to_path_buf()).or_insert(None);
            parent = path.parent();
        }
    }
    let mut result = Vec::with_capacity(expected.len());
    for (relative, size) in &expected {
        // Joining an empty path adds a trailing slash on Unix, which would
        // make symlink_metadata follow a root symlink. Inspect root directly.
        let path = if relative.as_os_str().is_empty() {
            dir.to_path_buf()
        } else {
            dir.join(relative)
        };
        let meta = fs::symlink_metadata(&path).ok()?;
        if let Some(size) = size {
            if !meta.is_file() || meta.len() != *size {
                return None;
            }
        } else {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return None;
            }
            for child in fs::read_dir(&path).ok()? {
                let child = child.ok()?;
                if !expected.contains_key(&relative.join(child.file_name())) {
                    return None;
                }
            }
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        result.push(Fingerprint {
            size: meta.len(), modified: meta.modified().ok(),
            #[cfg(unix)]
            // Root ctime changes on stage publication; inode still binds it.
            identity: (meta.dev(), meta.ino(), if relative.as_os_str().is_empty() { 0 } else { meta.ctime() }, if relative.as_os_str().is_empty() { 0 } else { meta.ctime_nsec() }),
        });
    }
    Some(Snapshot(result))
}

fn pin(spec: &ParakeetModelSpec) -> String {
    let mut hash = Sha256::new();
    hash.update(spec.revision.as_bytes());
    for file in spec.files {
        hash.update(file.path.as_bytes());
        hash.update([0]);
        hash.update(file.size_bytes.to_le_bytes());
        hash.update(file.sha256.as_bytes());
    }
    format!("{:x}", hash.finalize())
}
pub(super) fn verify_staged(
    spec: &ParakeetModelSpec,
    dir: &Path,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<CheckedSet, crate::model_fetch::FetchError> {
    use crate::model_fetch::{verify_file, FetchError};
    use std::sync::atomic::Ordering;
    let changed = || FetchError::HashMismatch {
        expected: "pinned set".to_owned(),
        actual: "changed set".to_owned(),
    };
    let before = snapshot(spec, dir).ok_or_else(changed)?;
    for file in spec.files {
        if cancel.load(Ordering::Acquire) {
            return Err(FetchError::Cancelled);
        }
        verify_file(&dir.join(file.path), &file.artifact())?;
    }
    if snapshot(spec, dir).as_ref() != Some(&before) {
        return Err(changed());
    }
    Ok(CheckedSet {
        pin: pin(spec),
        at: before,
        valid: true,
    })
}

impl CheckedSet {
    pub(super) fn verdict(&self, spec: &ParakeetModelSpec, dir: &Path) -> Option<bool> {
        (self.pin == pin(spec) && snapshot(spec, dir).as_ref() == Some(&self.at))
            .then_some(self.valid)
    }
}

impl super::ModelStore {
    /// Full hashing is restricted to startup/reverification worker threads.
    pub(super) fn verify_parakeet_existing(&self, spec: &ParakeetModelSpec) -> bool {
        let _hashing = self.hashing.lock().unwrap();
        let dir = self.root.join(spec.id);
        if let Some(verdict) = self.cached_parakeet_verdict(spec) {
            return verdict;
        }
        let Some(before) = snapshot(spec, &dir) else {
            return false;
        };
        let valid = spec.files.iter().all(|file| {
            crate::model_fetch::verify_file(&dir.join(file.path), &file.artifact()).is_ok()
        });
        let mut cache = self.parakeet_verified.lock().unwrap();
        if snapshot(spec, &dir).as_ref() != Some(&before) {
            return false;
        }
        cache.insert(
            spec.id,
            CheckedSet {
                pin: pin(spec),
                at: before,
                valid,
            },
        );
        valid
    }
    /// Whisper's rule (`store.rs` `info_for`/`resolved_path`): a structurally
    /// complete set whose hash check has not finished is usable (`Some(true)`)
    /// and queues one background check. Only a set that check found damaged,
    /// or an incomplete, extra or symlinked set, is `Some(false)`. `None`: no set.
    pub(super) fn parakeet_usable(&self, spec: &ParakeetModelSpec) -> Option<bool> {
        if let Some(verdict) = self.cached_parakeet_verdict(spec) {
            return Some(verdict);
        }
        let dir = self.root.join(spec.id);
        if snapshot(spec, &dir).is_some() {
            self.queue_parakeet_verify(*spec);
            return Some(true);
        }
        fs::symlink_metadata(&dir).is_ok().then_some(false)
    }
    pub(super) fn cached_parakeet_verdict(&self, spec: &ParakeetModelSpec) -> Option<bool> {
        let cached = self.parakeet_verified.lock().unwrap().get(spec.id).cloned();
        cached.and_then(|v| v.verdict(spec, &self.root.join(spec.id)))
    }
    fn queue_parakeet_verify(&self, spec: ParakeetModelSpec) {
        let Some(store) = self.this.get().and_then(|weak| weak.upgrade()) else {
            return;
        };
        if !self.parakeet_pending.lock().unwrap().insert(spec.id) {
            return;
        }
        std::thread::spawn(move || {
            store.verify_parakeet_existing(&spec);
            store.parakeet_pending.lock().unwrap().remove(spec.id);
            store.notify_models_changed();
        });
    }
}
