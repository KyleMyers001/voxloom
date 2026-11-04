//! The store's exclusive-write guard: one import or download at a time, and
//! never while a lease holds the model open.

use std::sync::{Arc, Mutex};

use super::{CleanupModelStore, StoreInner};

pub(super) struct ImportGuard {
    inner: Arc<Mutex<StoreInner>>,
}

impl Drop for ImportGuard {
    fn drop(&mut self) {
        self.inner.lock().unwrap().importing = false;
    }
}

impl CleanupModelStore {
    pub(super) fn begin_import(&self) -> Result<ImportGuard, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.leases > 0 {
            return Err("cleanup model is in use".into());
        }
        if inner.importing {
            return Err("cleanup model import is already running".into());
        }
        inner.importing = true;
        // Import replaces the on-disk bytes; drop any stale status cache.
        inner.verified = None;
        Ok(ImportGuard {
            inner: Arc::clone(&self.inner),
        })
    }
}
