/// Native microphone capture subsystem — BUS-9.
///
/// Public surface exposed to `lib.rs`:
/// - `coordinator::CaptureCoordinator` — managed state, start/stop.
/// - `coordinator::SessionEvent` — IPC-safe event type.
/// - `stream::list_input_device_names` — device enumeration for UI.
/// - `permission::query` — query without prompting.
pub mod buffer;
pub mod consumer;
pub mod coordinator;
pub mod permission;
pub mod resample;
pub mod stream;
