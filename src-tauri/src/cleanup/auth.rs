//! Caller authorization from Tauri's invoking webview labels (never IPC
//! arguments) plus session and request-ID parsing.

use tauri::{Runtime, Webview};

use super::CleanupCommandError;

pub(super) fn authorize_labels(webview: &str, window: &str) -> Result<(), CleanupCommandError> {
    if webview != "main" || window != "main" {
        return Err(CleanupCommandError::runtime(
            "cleanup is restricted to the main webview",
        ));
    }
    Ok(())
}

pub(super) fn require_main<R: Runtime>(webview: &Webview<R>) -> Result<(), CleanupCommandError> {
    // These labels come from Tauri's invoking Webview, never IPC arguments.
    authorize_labels(webview.label(), webview.window().label())
}

pub(super) fn authorize_model_manager(
    webview: &str,
    window: &str,
) -> Result<(), CleanupCommandError> {
    if webview == window && matches!(window, "main" | "settings") {
        return Ok(());
    }
    Err(CleanupCommandError::runtime(
        "cleanup models are restricted to main and settings",
    ))
}

pub(super) fn owner(session_id: &str) -> Result<u64, CleanupCommandError> {
    session_id
        .parse()
        .map_err(|_| CleanupCommandError::cancelled())
}

pub(super) fn validate_request_id(id: &str) -> Result<(), CleanupCommandError> {
    if id.is_empty() || id.len() > 128 {
        return Err(CleanupCommandError::runtime(
            "cleanup request ID must be 1 to 128 bytes",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_management_allows_settings_but_not_overlay_or_mismatched_labels() {
        assert!(authorize_model_manager("main", "main").is_ok());
        assert!(authorize_model_manager("settings", "settings").is_ok());
        assert!(authorize_model_manager("overlay", "overlay").is_err());
        assert!(authorize_model_manager("main", "settings").is_err());
    }

    #[test]
    fn only_the_native_main_webview_and_window_are_authorized() {
        assert!(authorize_labels("main", "main").is_ok());
        assert!(authorize_labels("overlay", "main").is_err());
        assert!(authorize_labels("main", "overlay").is_err());
        assert!(authorize_labels("overlay", "overlay").is_err());
        assert!(authorize_labels("", "main").is_err());
    }
}
