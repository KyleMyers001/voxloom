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
        Edge::AccessLost => "access-lost",
    }
}

/// Listen for the lone key `token` (e.g. `AltRight`, `F13`), replacing any
/// earlier one. macOS needs Accessibility; this only checks, never asks
/// (see `lone_key_request_access`).
#[tauri::command]
pub fn lone_key_arm(app: AppHandle, token: String) -> Result<(), String> {
    let key = parse_token(&token)?;
    arm_impl(app, key)
}

/// The user just saved a lone key: ask macOS for Accessibility if it is
/// not granted (this is the only place that prompts). Returns whether access
/// is granted right now; the prompt is answered later, so the caller still
/// arms through `lone_key_arm` and reports a refusal in words. Never called
/// at launch. Async, so a slow system prompt cannot stall the main thread.
#[tauri::command]
pub async fn lone_key_request_access() -> bool {
    tauri::async_runtime::spawn_blocking(request_access_impl)
        .await
        .unwrap_or(false)
}

/// Request only when the preflight says it is not granted yet.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn request_if_needed(
    granted: impl FnOnce() -> bool,
    request: impl FnOnce() -> bool,
) -> bool {
    granted() || request()
}

/// Stop listening. Safe to call when nothing is armed.
#[tauri::command]
pub fn lone_key_disarm() -> Result<(), String> {
    disarm_impl()
}

#[cfg(target_os = "macos")]
fn arm_impl(app: AppHandle, key: super::LoneKey) -> Result<(), String> {
    use tauri::Emitter;
    super::macos::arm(
        key,
        Box::new(move |edge| {
            // Only the main window runs gestures.
            let _ = app.emit_to("main", LONE_KEY_EVENT, edge_name(edge));
        }),
    )
}

#[cfg(target_os = "macos")]
fn request_access_impl() -> bool {
    super::access::request_access()
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
fn request_access_impl() -> bool {
    false // `lone_key_arm` then refuses with the macOS-only message
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
        assert_eq!(edge_name(Edge::AccessLost), "access-lost");
    }

    #[test]
    fn access_is_requested_only_when_not_already_granted() {
        use std::cell::Cell;
        let asked = Cell::new(0);
        let ask = |answer| {
            asked.set(asked.get() + 1);
            answer
        };
        assert!(request_if_needed(|| true, || ask(false)));
        assert_eq!(asked.get(), 0, "granted: must not prompt");
        assert!(!request_if_needed(|| false, || ask(false)));
        assert_eq!(asked.get(), 1, "denied: asks exactly once");
        assert!(request_if_needed(|| false, || ask(true)));
    }
}
