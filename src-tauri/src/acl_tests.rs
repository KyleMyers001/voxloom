//! BUS-42: the app command ACL (build.rs + capabilities/*.json) must let the
//! main window call `store_backup`, and deny it to the Settings and overlay
//! windows. Runs the REAL generated context on Tauri's mock runtime; a
//! same-named stub stands in for the command (the ACL keys on the name).

use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn store_backup(store: String) -> Result<Option<String>, String> {
    Ok(Some(format!("stub-{store}")))
}

fn invoke_from(app: &tauri::App<MockRuntime>, label: &str, page: &str) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .build()
        .expect("window");
    let url = window.url().expect("url");
    get_ipc_response(
        &window,
        InvokeRequest {
            cmd: "store_backup".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url,
            body: InvokeBody::Json(serde_json::json!({ "store": "settings" })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}

#[test]
fn store_backup_is_granted_to_main_only() {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![store_backup])
        .build(tauri::generate_context!())
        .expect("mock app");
    assert_eq!(invoke_from(&app, "main", "index.html"), Ok(()));
    let settings = invoke_from(&app, "settings", "settings.html").unwrap_err();
    assert!(settings.contains("not allowed"), "{settings}");
    let overlay = invoke_from(&app, "overlay", "overlay.html").unwrap_err();
    assert!(overlay.contains("not allowed"), "{overlay}");
}
