//! Where the cleanup worker binary lives (BUS-16 3c-2b). Release builds
//! bundle it as a Tauri `externalBin` sidecar, which lands next to the app
//! executable (`Voxloom.app/Contents/MacOS/voxloom-cleanup-worker`). Debug
//! builds fall back to a developer-placed copy under `src-tauri/resources`.

use std::path::{Path, PathBuf};

pub const WORKER_NAME: &str = "voxloom-cleanup-worker";

/// The bundled sidecar next to `app_exe` if it is there, else `fallback`.
/// An empty path means no worker: status reports the runtime unavailable.
pub fn resolve(app_exe: Option<&Path>, fallback: PathBuf) -> PathBuf {
    app_exe
        .and_then(Path::parent)
        .map(|dir| dir.join(WORKER_NAME))
        .filter(|sibling| sibling.is_file())
        .unwrap_or(fallback)
}

/// Debug builds only: `src-tauri/resources/cleanup/voxloom-cleanup-worker`,
/// e.g. a copy of the worker crate's own build.
pub fn development_fallback() -> PathBuf {
    #[cfg(debug_assertions)]
    return PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("cleanup")
        .join(WORKER_NAME);
    #[cfg(not(debug_assertions))]
    PathBuf::new()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::cleanup::test_support::test_root;

    fn bin_dir(label: &str) -> PathBuf {
        let dir = test_root().join(format!("worker-path-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_bundled_sidecar_next_to_the_app_wins() {
        let dir = bin_dir("sidecar");
        std::fs::write(dir.join(WORKER_NAME), b"").unwrap();
        let resolved = resolve(Some(&dir.join("voxloom")), PathBuf::from("/dev/x"));
        assert_eq!(resolved, dir.join(WORKER_NAME));
    }

    #[test]
    fn without_a_sidecar_the_fallback_is_used() {
        let dir = bin_dir("none");
        let fallback = PathBuf::from("/fallback/worker");
        assert_eq!(
            resolve(Some(&dir.join("voxloom")), fallback.clone()),
            fallback
        );
        assert_eq!(resolve(None, fallback.clone()), fallback);
    }

    #[test]
    fn a_directory_named_like_the_worker_is_not_a_worker() {
        let dir = bin_dir("dir");
        std::fs::create_dir(dir.join(WORKER_NAME)).unwrap();
        let resolved = resolve(Some(&dir.join("voxloom")), PathBuf::new());
        assert_eq!(resolved, PathBuf::new());
    }

    #[test]
    fn release_builds_have_no_development_fallback() {
        let fallback = development_fallback();
        if cfg!(debug_assertions) {
            assert!(fallback.ends_with("resources/cleanup/voxloom-cleanup-worker"));
        } else {
            assert_eq!(fallback, PathBuf::new());
        }
    }
}
