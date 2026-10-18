#[cfg(test)]
mod acl_tests;
mod cancel_scope;
mod capture;
mod cleanup;
mod delivery;
mod dictionary;
mod history;
mod hold_release;
mod overlay;
mod settings;
mod settings_window;
mod store_backup;
mod store_read;
mod stt;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use capture::pcm_store::PcmBufferStore;
use capture::{
    coordinator::{CaptureCoordinator, CaptureStatus, SessionEvent},
    permission,
    stream::{DeviceSelection, InputDeviceDescriptor, SYSTEM_DEFAULT_ID},
};
use stt::{store::ModelStore, SttState};

// IPC commands — capture

/// Query the current microphone permission without prompting.
/// Emits a `capture:event` PermissionStatus with generation 0 (not a session).
#[tauri::command]
fn capture_query_permission(app: AppHandle, request_id: String) {
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
    coordinator.start_session(request_id, selection, test_mode, move |event| {
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
fn capture_cancel(coordinator: State<CaptureCoordinator>, request_id: String) -> bool {
    coordinator.cancel_request(&request_id)
}

/// Return the exact active request, or null when idle.
#[tauri::command]
fn capture_status(coordinator: State<CaptureCoordinator>) -> Option<CaptureStatus> {
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let buffers = Arc::new(PcmBufferStore::new());
            let models = ModelStore::from_app(app.handle())
                .unwrap_or_else(|_| ModelStore::new(std::env::temp_dir().join("voxloom-models")));
            let coordinator = CaptureCoordinator::with_pcm_store(Arc::clone(&buffers));
            app.manage(coordinator);
            let cleanup =
                cleanup::CleanupState::from_app(app.handle()).expect("initialize cleanup state");
            app.manage(cleanup);
            app.manage(SttState::new(models, buffers));
            #[cfg(target_os = "macos")]
            app.set_menu(settings_window::app_menu(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == settings_window::SETTINGS_MENU_ID {
                let _ = settings_window::open_settings_window(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            cancel_scope::dictation_cancel_arm,
            cancel_scope::dictation_cancel_finish,
            cancel_scope::dictation_cancel_end,
            capture_cancel,
            capture_list_devices,
            capture_query_permission,
            capture_request_permission,
            capture_start,
            capture_status,
            capture_stop,
            cleanup::commands::cleanup_acquire,
            cleanup::commands::cleanup_cancel,
            cleanup::commands::cleanup_pick_and_import_model,
            cleanup::commands::cleanup_model_status,
            cleanup::commands::cleanup_release,
            cleanup::commands::cleanup_run,
            cleanup::commands::cleanup_session_open,
            cleanup::commands::cleanup_session_dispose,
            delivery::delivery_insert_text,
            delivery::delivery_snapshot_target,
            delivery::delivery_validate_target,
            dictionary::dictionary_load,
            dictionary::dictionary_save,
            history::history_load,
            history::history_save,
            hold_release::hold_release_arm,
            hold_release::hold_release_disarm,
            overlay::overlay_ensure,
            overlay::overlay_hide,
            overlay::overlay_show,
            settings::settings_load,
            settings::settings_save,
            settings_window::settings_request_onboarding,
            settings_window::settings_window_open,
            store_backup::store_backup,
            stt::stt_cancel_download,
            stt::stt_download_model,
            stt::stt_list_models,
            stt::stt_model_status,
            stt::stt_transcribe,
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                if let Some(cleanup) = webview.try_state::<cleanup::CleanupState>() {
                    cleanup.retire_main(webview.label());
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(cleanup) = window.try_state::<cleanup::CleanupState>() {
                    cleanup.retire_main(window.label());
                }
            }
            // Only closing main ends capture; closing Settings must not.
            if window.label() != settings_window::MAIN_LABEL {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                cancel_scope::close();
                if let Some(coordinator) = window.try_state::<CaptureCoordinator>() {
                    coordinator.cancel_any();
                }
                if let Some(settings) = window
                    .app_handle()
                    .get_webview_window(settings_window::SETTINGS_LABEL)
                {
                    let _ = settings.close();
                }
            }
        });
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let builder = builder.on_web_content_process_terminate(|webview| {
        if let Some(cleanup) = webview.try_state::<cleanup::CleanupState>() {
            cleanup.retire_main(webview.label());
        }
    });
    builder.run(app_context()).expect("failed to run Voxloom");
}

/// The single `generate_context!` expansion. Invoking the macro twice in one
/// crate (e.g. again in tests) emits `_EMBED_INFO_PLIST` twice and fails to
/// link on macOS with a duplicate symbol.
pub(crate) fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}
