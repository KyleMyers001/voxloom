//! The Settings window (UI PR 6b): a second webview opened from the app
//! menu ("Settings… ⌘,"), the main title-bar button and ⌥4. At most one
//! exists; opening again focuses it.

use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const SETTINGS_LABEL: &str = "settings";
pub const MAIN_LABEL: &str = "main";
pub const SETTINGS_MENU_ID: &str = "open-settings";
pub const SETTINGS_CHANGED_EVENT: &str = "settings:changed";
pub const ONBOARDING_OPEN_EVENT: &str = "onboarding:open";
const SETTINGS_URL: &str = "settings.html";

/// Payload of `settings:changed`: the raw `settings.json` contents just saved
/// and the label of the window that saved them. Receivers ignore their own
/// label: an any-target `listen()` gets every emit regardless of filters.
#[derive(Clone, Serialize)]
pub struct SettingsChanged {
    pub contents: String,
    pub source: String,
}

/// Open the Settings window, or focus it if it is already open.
pub fn open_settings_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App(SETTINGS_URL.into()))
        .title("Settings")
        .inner_size(760.0, 600.0)
        .resizable(false)
        .minimizable(false)
        .focused(true)
        .build()
        .map(|_| ())
        .map_err(|e| format!("open settings window: {e}"))
}

/// Tell the windows that settings.json changed; `source` lets the saver ignore it.
pub fn broadcast_settings_changed<R: Runtime>(app: &AppHandle<R>, source: &str, contents: String) {
    let payload = SettingsChanged {
        contents,
        source: source.to_owned(),
    };
    // Plain broadcast: the receiver-side `source` check is the real guard
    // (an any-target listener would get a filtered emit anyway).
    let _ = app.emit(SETTINGS_CHANGED_EVENT, payload);
}

/// Open or focus the Settings window.
#[tauri::command]
pub fn settings_window_open(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app)
}

/// "Set up shortcuts…" from the Settings window: focus main and open onboarding there.
#[tauri::command]
pub fn settings_request_onboarding(app: AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| "main window is not open".to_string())?;
    let _ = main.unminimize();
    main.show().map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())?;
    main.emit_to(MAIN_LABEL, ONBOARDING_OPEN_EVENT, ())
        .map_err(|e| e.to_string())
}

/// The default menu with "Settings… ⌘," added to the app (first) submenu,
/// after "About". Only installed on macOS, where the menu bar is global.
#[cfg(target_os = "macos")]
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let item = MenuItem::with_id(
        app,
        SETTINGS_MENU_ID,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    if let Some(app_submenu) = menu
        .items()?
        .first()
        .and_then(|kind| kind.as_submenu().cloned())
    {
        let separator = PredefinedMenuItem::separator(app)?;
        app_submenu.insert_items(&[&separator, &item], 1)?;
    } else {
        menu.append(&item)?;
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_events_match_the_frontend_contract() {
        // Mirrors src/services/settingsWindow/constants.ts.
        assert_eq!(SETTINGS_LABEL, "settings");
        assert_eq!(SETTINGS_CHANGED_EVENT, "settings:changed");
        assert_eq!(ONBOARDING_OPEN_EVENT, "onboarding:open");
        assert_eq!(SETTINGS_URL, "settings.html");
    }
}
