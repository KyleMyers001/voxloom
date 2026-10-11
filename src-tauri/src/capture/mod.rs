/// Native microphone capture subsystem — BUS-9.
///
/// Public surface exposed to `lib.rs`:
/// - `coordinator::CaptureCoordinator` — managed state, start/stop.
/// - `coordinator::SessionEvent` — IPC-safe event type.
/// - `stream::DeviceRegistry` — opaque input-device selection metadata.
/// - `permission::query` — query without prompting.
pub mod buffer;
pub mod consumer;
pub mod coordinator;
pub mod identity;
pub mod pcm_store;
pub mod permission;
pub mod resample;
pub mod stream;
