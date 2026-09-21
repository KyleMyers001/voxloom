mod capture;
mod stt;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use capture::{
    coordinator::{CaptureCoordinator, CaptureStatus, SessionEvent},
    permission,
    stream::{
        DeviceSelection, InputDeviceDescriptor, SYSTEM_DEFAULT_ID,
    },
};
use capture::pcm_store::PcmBufferStore;
use stt::{store::ModelStore, SttState};

// IPC commands — capture

/// Query the current microphone permission without prompting.
/// Emits a `capture:event` PermissionStatus with generation 0 (not a session).
#[tauri::command]
fn capture_query_permission(
    app: AppHandle,
    request_id: String,
) {
    let status = permission::query();
    let _ = app.emit(
        "capture:event",
        SessionEvent::PermissionStatus {
            generation: 0,
            request_id,
            status: status.into(),
        },
    );
}

/// Request microphone permission. Emits updated PermissionStatus.
#[tauri::command]
fn capture_request_permission(app: AppHandle, request_id: String) {
    use capture::permission::MicPermission;
    match permission::query() {
        MicPermission::NotDetermined => {
            let app2 = app.clone();
            let callback_request_id = request_id.clone();
            permission::request(move |granted| {
                use capture::coordinator::PermissionStatus;
                let status = if granted {
                    PermissionStatus::Authorized
                } else {
                    PermissionStatus::Denied
                };
                let _ = app2.emit(
                    "capture:event",
                    SessionEvent::PermissionStatus {
                        generation: 0,
                        request_id: callback_request_id.clone(),
                        status,
                    },
                );
            });
        }
        other => {
            let _ = app.emit(
                "capture:event",
                SessionEvent::PermissionStatus {
                    generation: 0,
                    request_id,
                    status: other.into(),
                },
            );
        }
    }
}

/// Start a capture session.
/// Returns the session generation as a string (e.g., `"1"`), or an error.
#[tauri::command]
fn capture_start(
    app: AppHandle,
    coordinator: State<CaptureCoordinator>,
    preferred_device_id: Option<String>,
    request_id: String,
    test_mode: bool,
) -> Result<CaptureStatus, String> {
    let selection = match preferred_device_id {
        Some(id) if id != SYSTEM_DEFAULT_ID => DeviceSelection::Id(id),
        _ => DeviceSelection::SystemDefault,
    };
    let app2 = app.clone();
    coordinator
        .start_session(request_id, selection, test_mode, move |event| {
            let _ = app2.emit("capture:event", event);
        })
}

/// Clean-stop any active capture session (deposit PCM + capture-stopped).
/// Distinct from `capture_cancel`, which discards audio.
#[tauri::command]
fn capture_stop(coordinator: State<CaptureCoordinator>) {
    coordinator.stop_any();
}

/// Cancel one client request, including a start whose response is pending.
#[tauri::command]
fn capture_cancel(
    coordinator: State<CaptureCoordinator>,
    request_id: String,
) -> bool {
    coordinator.cancel_request(&request_id)
}

/// Return the exact active request, or null when idle.
#[tauri::command]
fn capture_status(
    coordinator: State<CaptureCoordinator>,
) -> Option<CaptureStatus> {
    coordinator.status()
}

/// Refresh and enumerate process-local input device descriptors.
#[tauri::command]
fn capture_list_devices(
    coordinator: State<CaptureCoordinator>,
) -> Result<Vec<InputDeviceDescriptor>, String> {
    coordinator.list_devices()
}

// Application entry

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let buffers = Arc::new(PcmBufferStore::new());
            let models = ModelStore::from_app(app.handle())
                .unwrap_or_else(|_| {
                    ModelStore::new(
                        std::env::temp_dir().join("voxloom-models"),
                    )
                });
            let coordinator =
                CaptureCoordinator::with_pcm_store(Arc::clone(&buffers));
            app.manage(coordinator);
            app.manage(SttState::new(models, buffers));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_cancel,
            capture_list_devices,
            capture_query_permission,
            capture_request_permission,
            capture_start,
            capture_status,
            capture_stop,
            stt::stt_cancel_download,
            stt::stt_download_model,
            stt::stt_list_models,
            stt::stt_model_status,
            stt::stt_transcribe,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(coordinator) =
                    window.try_state::<CaptureCoordinator>()
                {
                    coordinator.cancel_any();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Voxloom");
}
