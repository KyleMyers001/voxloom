//! IPC for a lone key as the whole shortcut (BUS-46 slice 3). The webview
//! arms and disarms it, and gets the edges back as `shortcut:lone-key`
//! events; the existing gesture machine does the rest.

use super::machine::Edge;
use super::parse_token;
use tauri::AppHandle;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const LONE_KEY_EVENT: &str = "shortcut:lone-key";

/// What the webview hears for each edge.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn edge_name(edge: Edge) -> &'static str {
    match edge {
        Edge::Pressed => "pressed",
        Edge::Released => "released",
        Edge::Cancelled => "cancelled",
    }
}

/// Listen for the lone key `token` (e.g. `AltRight`, `F13`), replacing any
/// earlier one. macOS needs Input Monitoring; this only checks, never asks.
#[tauri::command]
pub fn lone_key_arm(app: AppHandle, token: String) -> Result<(), String> {
    let key = parse_token(&token)?;
    arm_impl(app, key)
}

/// Stop listening. Safe to call when nothing is armed.
#[tauri::command]
pub fn lone_key_disarm() -> Result<(), String> {
    disarm_impl()
}

#[cfg(target_os = "macos")]
fn arm_impl(app: AppHandle, key: super::LoneKey) -> Result<(), String> {
    use tauri::Emitter;
    let target = app.clone();
    super::macos::arm(
        app,
        key,
        Box::new(move |edge| {
            // Only the main window runs gestures.
            let _ = target.emit_to("main", LONE_KEY_EVENT, edge_name(edge));
        }),
    )
}

#[cfg(target_os = "macos")]
fn disarm_impl() -> Result<(), String> {
    super::macos::disarm()
}

#[cfg(not(target_os = "macos"))]
fn arm_impl(_app: AppHandle, _key: super::LoneKey) -> Result<(), String> {
    Err("Using a single key as the shortcut is only supported on macOS".into())
}

#[cfg(not(target_os = "macos"))]
fn disarm_impl() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_reach_the_webview_under_stable_names() {
        assert_eq!(edge_name(Edge::Pressed), "pressed");
        assert_eq!(edge_name(Edge::Released), "released");
        assert_eq!(edge_name(Edge::Cancelled), "cancelled");
    }
}
