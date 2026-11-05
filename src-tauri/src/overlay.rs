//! Desktop dictation waveform overlay window (BUS-13).
//! Transparent, always-on-top, non-focusable, bottom-center of the work area
//! (above a visible Dock; see overlay_placement.rs).
//! Delivery/insert is out of scope — this window must never steal focus.

use crate::overlay_placement::{place, work_area_logical};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const OVERLAY_URL: &str = "overlay.html";

/// Place the pill bottom-center of the monitor's work area (BUS-177).
///
/// `work_area()` is `NSScreen.visibleFrame` on macOS, so a visible Dock (bottom,
/// left or right) and the menu bar are excluded. It is computed fresh on every
/// call. Everything is converted to logical points with the *same* monitor's
/// scale factor and applied as a `LogicalPosition`, so tao does not re-scale it
/// with the window's current screen.
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

    // The builder and CSS dimensions are logical points. PhysicalSize here
    // clipped the pill on Retina displays, exposing a square window edge.
    window
        .set_size(LogicalSize::new(width as f64, height as f64))
        .map_err(|e| e.to_string())?;
    let area = monitor.work_area();
    let work = work_area_logical(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
        monitor.scale_factor(),
    );
    let (x, y) = place(work, width as f64, height as f64, margin_bottom as f64);
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn build_overlay(
    app: &AppHandle,
    label: &str,
    width: u32,
    height: u32,
) -> Result<WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(OVERLAY_URL.into()))
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
        .transparent(true)
        .shadow(false);

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
    cancellable: bool,
) -> Result<(), String> {
    if cancellable && !crate::cancel_scope::can_show() {
        return Err("Dictation cancellation scope is no longer active".into());
    }
    let window = get_or_create(&app, &label, width, height)?;
    position_bottom_center(&window, width, height, margin_bottom)?;
    let _ = window.set_focusable(false);
    let _ = window.set_always_on_top(true);
    // The HUD has no pointer UI. Pass clicks through to the apps beneath it,
    // including the transparent clearance around the pill and its halo.
    let _ = window.set_ignore_cursor_events(true);
    // Show without taking focus — never call set_focus(true).
    window.show().map_err(|e| e.to_string())?;
    crate::cancel_scope::visible(cancellable);
    Ok(())
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle, label: String) -> Result<(), String> {
    crate::cancel_scope::visible(false);
    if let Some(window) = app.get_webview_window(&label) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
