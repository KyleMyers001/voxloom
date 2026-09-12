mod capture;

use tauri::{AppHandle, Emitter, Manager, State};

use capture::{
    coordinator::{CaptureCoordinator, SessionEvent},
    permission,
    stream::{list_input_device_names, DeviceSelection},
};

// ── IPC commands ──────────────────────────────────────────────────────────

/// Query the current microphone permission without prompting.
/// Emits a `capture:event` PermissionStatus event.
#[tauri::command]
fn capture_query_permission(
    app: AppHandle,
    _coordinator: State<CaptureCoordinator>,
) {
    let status = permission::query();
    let event = SessionEvent::PermissionStatus {
        status: status.into(),
    };
    let _ = app.emit("capture:event", event);
}

/// Request microphone permission (prompts when NotDetermined).
/// Emits `capture:event` PermissionStatus on completion.
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
                    SessionEvent::PermissionStatus { status },
                );
            });
        }
        other => {
            let _ = app.emit(
                "capture:event",
                SessionEvent::PermissionStatus {
                    status: other.into(),
                },
            );
        }
    }
}

/// Start a capture session.
///
/// `preferred_device`: exact device name, or null for system default.
/// `test_mode`: auto-stops after 10 s and emits TestComplete.
///
/// Returns `"ok"` or a stable error string.
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
        .map_err(|e| e)
}

/// Stop (cancel) the active capture session. Idempotent.
#[tauri::command]
fn capture_stop(coordinator: State<CaptureCoordinator>) {
    coordinator.cancel_any();
}

/// Cancel a specific session generation.
#[tauri::command]
fn capture_cancel(
    coordinator: State<CaptureCoordinator>,
    generation: u64,
) -> bool {
    coordinator.cancel(generation)
}

/// True when a capture session is currently active.
#[tauri::command]
fn capture_is_active(
    coordinator: State<CaptureCoordinator>,
) -> bool {
    coordinator.is_active()
}

/// Enumerate input device names.
/// Also emits `capture:event` DeviceList for the frontend to observe.
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
