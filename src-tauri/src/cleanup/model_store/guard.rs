//! The store's exclusive-write guard: one download (or test install) at a
//! time, and never while a lease holds the model open.

use std::sync::{Arc, Mutex};

use super::{CleanupModelStore, StoreInner};

pub(super) struct WriteGuard {
    inner: Arc<Mutex<StoreInner>>,
}

impl Drop for WriteGuard {
    fn drop(&mut self) {
        self.inner.lock().unwrap().writing = false;
    }
}

impl CleanupModelStore {
    pub(super) fn begin_write(&self) -> Result<WriteGuard, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.leases > 0 {
            return Err("cleanup model is in use".into());
        }
        if inner.writing {
            return Err("cleanup model download is already running".into());
        }
        inner.writing = true;
        // A write replaces the on-disk bytes; drop any stale status cache.
        inner.verified = None;
        Ok(WriteGuard {
            inner: Arc::clone(&self.inner),
        })
    }
}
