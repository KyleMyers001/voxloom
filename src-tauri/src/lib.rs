mod capture;

use tauri::{AppHandle, Emitter, Manager, State};

use capture::{
    coordinator::{CaptureCoordinator, SessionEvent},
    permission,
    stream::list_input_device_names,
};

// ── IPC commands ──────────────────────────────────────────────────────────

/// Query the current microphone permission without prompting.
///
/// Emits a `capture:permission-status` event; does not return the status
/// directly so the renderer always uses the event channel.
#[tauri::command]
fn capture_query_permission(
    app: AppHandle,
    coordinator: State<CaptureCoordinator>,
) {
    let status = permission::query();
    let event = SessionEvent::PermissionStatus {
        status: status.into(),
    };
    let _ = app.emit("capture:event", event);
    // Suppress unused warning on non-macOS where coordinator is not
    // used in this command.
    let _ = &coordinator;
}

/// Request microphone permission if not yet determined.
///
/// Triggers the OS dialog when status is NotDetermined. Emits
/// `capture:event` with updated `PermissionStatus` on completion.
/// Does nothing when already Authorized or Denied.
#[tauri::command]
fn capture_request_permission(app: AppHandle) {
    use capture::permission::MicPermission;
    match permission::query() {
        MicPermission::NotDetermined => {
            let app2 = app.clone();
            permission::request(move |granted| {
                let status = if granted {
                    capture::coordinator::PermissionStatus::Authorized
                } else {
                    capture::coordinator::PermissionStatus::Denied
                };
                let event = SessionEvent::PermissionStatus { status };
                let _ = app2.emit("capture:event", event);
            });
        }
        other => {
            let event = SessionEvent::PermissionStatus {
                status: other.into(),
            };
            let _ = app.emit("capture:event", event);
        }
    }
}

/// Start a capture session.
///
/// `preferred_device`: exact device name, or null for system default.
/// `test_mode`: when true the session auto-stops after 10 s and emits
/// `TestComplete` with content-free metadata.
///
/// Returns `"ok"` or a stable error category string.
#[tauri::command]
fn capture_start(
    app: AppHandle,
    coordinator: State<CaptureCoordinator>,
    preferred_device: Option<String>,
    test_mode: bool,
) -> Result<String, String> {
    let app2 = app.clone();
    coordinator
        .start_session(preferred_device, test_mode, move |event| {
            let _ = app2.emit("capture:event", event);
        })
        .map(|_| String::from("ok"))
}

/// Stop the active capture session. Idempotent.
#[tauri::command]
fn capture_stop(coordinator: State<CaptureCoordinator>) {
    coordinator.request_stop();
}

/// Return true when a capture session is currently active.
#[tauri::command]
fn capture_is_active(
    coordinator: State<CaptureCoordinator>,
) -> bool {
    coordinator.is_active()
}

/// Enumerate input device names using the default CPAL host.
///
/// Emits `capture:event` with a `DeviceList`; returns the list directly.
#[tauri::command]
fn capture_list_devices(app: AppHandle) -> Vec<String> {
    let devices = list_input_device_names();
    let event = SessionEvent::DeviceList {
        devices: devices.clone(),
    };
    let _ = app.emit("capture:event", event);
    devices
}

// ── Application entry ─────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CaptureCoordinator::new())
        .invoke_handler(tauri::generate_handler![
            capture_is_active,
            capture_list_devices,
            capture_query_permission,
            capture_request_permission,
            capture_start,
            capture_stop,
        ])
        .on_window_event(|window, event| {
            // Stop any active capture when the window closes.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(coordinator) = window
                    .try_state::<CaptureCoordinator>()
                {
                    coordinator.request_stop();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Voxloom");
}
