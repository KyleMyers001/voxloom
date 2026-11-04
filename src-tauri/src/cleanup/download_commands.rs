//! Tauri commands for the one-click cleanup model download (BUS-181).
//! Progress is emitted on `cleanup:download-progress`; the invoke resolves
//! with the new status only after the file is verified and in place.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Runtime, State, Webview};

use super::auth::authorize_model_manager;
use super::model_store::{download::DownloadError, ModelStatus};
use super::{CleanupCommandError, CleanupState};

pub const PROGRESS_EVENT: &str = "cleanup:download-progress";

#[tauri::command]
pub async fn cleanup_download_model<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    state: State<'_, CleanupState>,
) -> Result<ModelStatus, CleanupCommandError> {
    authorize_model_manager(webview.label(), webview.window().label())?;
    let models = Arc::clone(&state.models);
    let mut status = tauri::async_runtime::spawn_blocking(move || {
        models
            .download(|progress| {
                let _ = app.emit(PROGRESS_EVENT, progress);
            })
            .map_err(download_error)
    })
    .await
    .map_err(|error| {
        CleanupCommandError::runtime(format!("model download task failed: {error}"))
    })??;
    status.runtime_available = state.supervisor.available();
    Ok(status)
}

/// Cheap and synchronous, so it can stop a download on the blocking pool.
#[tauri::command]
pub fn cleanup_cancel_download<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, CleanupState>,
) -> Result<bool, CleanupCommandError> {
    authorize_model_manager(webview.label(), webview.window().label())?;
    Ok(state.models.cancel_download())
}

/// `cancelled` and `checksum-mismatch` get their own UI lines; anything else
/// (offline, I/O, in use) is a runtime error with the reason.
fn download_error(error: DownloadError) -> CleanupCommandError {
    let (code, message) = match error {
        DownloadError::Cancelled => ("cancelled", "download cancelled".to_owned()),
        DownloadError::Checksum => (
            "checksum-mismatch",
            "downloaded file did not match the pinned size and SHA-256".to_owned(),
        ),
        DownloadError::Failed(message) => return CleanupCommandError::runtime(message),
    };
    CleanupCommandError {
        code,
        message,
        attempt: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_errors_map_to_distinct_codes() {
        assert_eq!(download_error(DownloadError::Cancelled).code, "cancelled");
        assert_eq!(
            download_error(DownloadError::Checksum).code,
            "checksum-mismatch"
        );
        let failed = download_error(DownloadError::Failed("offline".into()));
        assert_eq!(
            (failed.code, failed.message.as_str()),
            ("runtime-error", "offline")
        );
    }
}
