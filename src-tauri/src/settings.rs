//! Durable Settings store (`app_data_dir/settings.json`).
//!
//! Atomic write: temp file + rename. Load failures are returned to the
//! frontend — callers must not silently wipe a corrupt file, and must
//! never touch `history.json` from this path.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::settings_window::broadcast_settings_changed;

const SETTINGS_FILE_NAME: &str = "settings.json";

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join(SETTINGS_FILE_NAME))
}

/// Read raw settings JSON. Returns `null` when the file does not exist.
#[tauri::command]
pub fn settings_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = settings_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read settings.json: {e}"))?;
    Ok(Some(raw))
}

/// Atomically replace `settings.json` with `contents`, then tell the other
/// windows (`settings:changed`) so they re-hydrate without a restart.
#[tauri::command]
pub fn settings_save(
    app: AppHandle,
    window: WebviewWindow,
    contents: String,
) -> Result<(), String> {
    write_settings(&app, &contents)?;
    broadcast_settings_changed(&app, window.label(), contents);
    Ok(())
}

fn write_settings(app: &AppHandle, contents: &str) -> Result<(), String> {
    let path = settings_path(app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents.as_bytes()).map_err(|e| format!("write settings.json.tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename settings.json.tmp: {e}")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("voxloom-settings-test-{nanos}"))
    }

    #[test]
    fn atomic_save_round_trip() {
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SETTINGS_FILE_NAME);
        let tmp = path.with_extension("json.tmp");
        let body = "{\"version\":1,\"onboardingComplete\":false,\"settings\":{}}\n";
        fs::write(&tmp, body).unwrap();
        fs::rename(&tmp, &path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        let _ = fs::remove_dir_all(&dir);
    }
}
