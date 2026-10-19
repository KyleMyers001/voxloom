//! Background hashing: the one-time startup pass, and one re-check of a file
//! whose open-failed verdict cleared (Sophie's option (a)). Both only ever
//! run off the UI/IPC thread and the transcription path; a file being
//! checked stays usable.

use std::sync::Arc;
use std::thread::JoinHandle;

use super::super::ModelStore;
use crate::stt::catalog;

impl ModelStore {
    /// Startup: verify any present, unmarked model files on a background
    /// thread. `on_verdict` runs after each file is checked, so Settings can
    /// re-list (`stt:models-changed`). Also enables `queue_reverify`. The
    /// handle is for tests; the app detaches it.
    pub fn spawn_verify_existing(
        self: &Arc<Self>,
        on_verdict: impl Fn() + Send + 'static,
    ) -> JoinHandle<()> {
        let _ = self.this.set(Arc::downgrade(self));
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            for spec in catalog::CATALOG {
                if store.model_path(spec).is_file()
                    && store.known_verdict(spec).is_none()
                    && store.verify_existing(spec).is_some()
                {
                    on_verdict();
                }
            }
        })
    }

    /// Hash `spec` once more in the background (same rule as the startup
    /// pass), then re-list. At most one re-check per model is pending or
    /// running; a store whose startup pass never ran (unit tests) skips it.
    pub(in crate::stt::store) fn queue_reverify(&self, model_id: &str) {
        let Some(spec) = catalog::find(model_id) else {
            return;
        };
        let Some(store) = self.this.get().and_then(|weak| weak.upgrade()) else {
            return;
        };
        if !self.reverifying.lock().unwrap().insert(spec.id) {
            return;
        }
        std::thread::spawn(move || {
            let checked = store.verify_existing(spec).is_some();
            store.reverifying.lock().unwrap().remove(spec.id);
            if checked {
                store.notify_models_changed();
            }
        });
    }
}
