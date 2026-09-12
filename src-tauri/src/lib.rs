mod capture;

use tauri::{AppHandle, Emitter, Manager, State};

use capture::{
    coordinator::{CaptureCoordinator, SessionEvent},
    permission,
    stream::{list_input_device_names, DeviceSelection},
};

// ── IPC commands ──────────────────────────────────────────────────────────

/// Query the current microphone permission without prompting.
/// Emits a `capture:event` PermissionStatus with generation 0 (not a session).
#[tauri::command]
fn capture_query_permission(
    app: AppHandle,
    _coordinator: State<CaptureCoordinator>,
) {
    let status = permission::query();
    let _ = app.emit(
        "capture:event",
        SessionEvent::PermissionStatus {
            generation: 0,
            status: status.into(),
        },
    );
}

/// Request microphone permission. Emits updated PermissionStatus.
#[tauri::command]
fn capture_request_permission(app: AppHandle) {
    use capture::permission::MicPermission;
    match permission::query() {
        MicPermission::NotDetermined => {
            let app2 = app.clone();
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
    preferred_device: Option<String>,
    test_mode: bool,
) -> Result<String, String> {
    let selection = match preferred_device {
        Some(name) => DeviceSelection::Named(name),
        None => DeviceSelection::SystemDefault,
    };
    let app2 = app.clone();
    coordinator
        .start_session(selection, test_mode, move |event| {
            let _ = app2.emit("capture:event", event);
        })
        .map(|gen| gen.to_string())
}

/// Cancel any active capture session.
#[tauri::command]
fn capture_stop(coordinator: State<CaptureCoordinator>) {
    coordinator.cancel_any();
}

/// Cancel a specific session by generation.
#[tauri::command]
fn capture_cancel(
    coordinator: State<CaptureCoordinator>,
    generation: u64,
) -> bool {
    coordinator.cancel(generation)
}

/// True when a session is active.
#[tauri::command]
fn capture_is_active(
    coordinator: State<CaptureCoordinator>,
) -> bool {
    coordinator.is_active()
}

/// Enumerate input device names.
#[tauri::command]
fn capture_list_devices(app: AppHandle) -> Vec<String> {
    let devices = list_input_device_names();
    let _ = app.emit(
        "capture:event",
        SessionEvent::DeviceList {
            devices: devices.clone(),
        },
    );
    devices
}

// ── Application entry ─────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CaptureCoordinator::new())
        .invoke_handler(tauri::generate_handler![
            capture_cancel,
            capture_is_active,
            capture_list_devices,
            capture_query_permission,
            capture_request_permission,
            capture_start,
            capture_stop,
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
