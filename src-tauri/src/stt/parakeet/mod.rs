//! Isolated, bounded per-recording Parakeet workers. Whisper does not use this runtime.
mod process;
mod protocol;
mod runtime;
pub use runtime::ParakeetRuntime;

/// The verified directories one Parakeet worker loads: the speech model, and
/// the shared CTC set that boosts the user's dictionary words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDirs {
    pub model: std::path::PathBuf,
    pub vocabulary: std::path::PathBuf,
}
pub mod worker_path;
#[cfg(all(test, unix))]
pub(crate) use process::tests::{fixture, model_dirs, NORMAL};
