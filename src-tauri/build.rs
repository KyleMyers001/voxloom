// App command ACL: with an app manifest, each window may only invoke the
// commands its capability allows (`allow-<command>`, underscores → hyphens).
// main: everything; settings: settings + model management + the mic test;
// overlay: none.
const COMMANDS: &[&str] = &[
    "dictation_cancel_arm",
    "dictation_cancel_finish",
    "dictation_cancel_end",
    "capture_cancel",
    "capture_list_devices",
    "capture_query_permission",
    "capture_request_permission",
    "capture_start",
    "capture_status",
    "capture_stop",
    "delivery_insert_text",
    "delivery_snapshot_target",
    "delivery_validate_target",
    "dictionary_load",
    "dictionary_save",
    "history_load",
    "history_save",
    "hold_release_arm",
    "hold_release_disarm",
    "overlay_ensure",
    "overlay_hide",
    "overlay_show",
    "settings_load",
    "settings_request_onboarding",
    "settings_save",
    "settings_window_open",
    "store_backup",
    "stt_cancel_download",
    "stt_download_model",
    "stt_list_models",
    "stt_model_status",
    "stt_transcribe",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
