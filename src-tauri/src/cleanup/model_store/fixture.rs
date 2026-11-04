//! Test-only install: puts a model in place under the same write guard as a
//! download, so tests can stand up an installed model without a server.

use std::fs;
use std::path::Path;

use super::{validate_artifact, ArtifactSpec, CleanupModelStore};

impl CleanupModelStore {
    pub(crate) fn install_fixture(
        &self,
        source: &Path,
        artifact: ArtifactSpec,
    ) -> Result<(), String> {
        let _guard = self.begin_write()?;
        validate_artifact(source, artifact)?;
        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        let destination = self.model_path();
        if validate_artifact(&destination, artifact).is_err() {
            fs::copy(source, &destination).map_err(|error| error.to_string())?;
        }
        self.remember_verified(&destination);
        Ok(())
    }
}
