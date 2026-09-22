//! Desktop dictation waveform overlay window (BUS-13).
//! Transparent, always-on-top, non-focusable, bottom-center.
//! Delivery/insert is out of scope — this window must never steal focus.

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

const OVERLAY_URL: &str = "overlay.html";

fn position_bottom_center(
    window: &WebviewWindow,
    width: u32,
    height: u32,
    margin_bottom: i32,
) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor available for overlay".to_string())?;

    let screen = monitor.size();
    let origin = monitor.position();
    let x = origin.x + ((screen.width as i32 - width as i32) / 2);
    let y = origin.y + (screen.height as i32 - height as i32 - margin_bottom);
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn build_overlay(
    app: &AppHandle,
    label: &str,
    width: u32,
    height: u32,
) -> Result<WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(OVERLAY_URL.into()),
    )
    .title("Voxloom dictation")
    .inner_size(width as f64, height as f64)
    .decorations(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .focused(false)
    .focusable(false)
    .visible(false)
    .transparent(true);

    // macOS: transparent requires private API (enabled in tauri.conf).
    // Linux builds still compile; transparency works without private API.
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(false);

    builder.build().map_err(|e| e.to_string())
}

fn get_or_create(
    app: &AppHandle,
    label: &str,
    width: u32,
    height: u32,
) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(label) {
        return Ok(existing);
    }
    build_overlay(app, label, width, height)
}

#[tauri::command]
pub fn overlay_ensure(
    app: AppHandle,
    label: String,
    width: u32,
    height: u32,
    margin_bottom: i32,
) -> Result<(), String> {
    let window = get_or_create(&app, &label, width, height)?;
    position_bottom_center(&window, width, height, margin_bottom)?;
    // Re-assert non-focusable after create (some platforms reset flags).
    let _ = window.set_focusable(false);
    Ok(())
}

#[tauri::command]
pub fn overlay_show(
    app: AppHandle,
    label: String,
    width: u32,
    height: u32,
    margin_bottom: i32,
) -> Result<(), String> {
    let window = get_or_create(&app, &label, width, height)?;
    position_bottom_center(&window, width, height, margin_bottom)?;
    let _ = window.set_focusable(false);
    let _ = window.set_always_on_top(true);
    // Show without taking focus — never call set_focus(true).
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
