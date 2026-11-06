//! Isolated, bounded per-recording Parakeet workers. Whisper does not use this runtime.
mod process;
mod protocol;
mod runtime;
pub use runtime::ParakeetRuntime;
pub mod worker_path;
#[cfg(all(test, unix))]
pub(crate) use process::tests::{fixture, NORMAL};
