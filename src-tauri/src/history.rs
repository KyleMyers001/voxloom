//! Durable History / Recent transcript store (`app_data_dir/history.json`).
//!
//! Atomic write: temp file + rename. Load failures are returned to the
//! frontend — callers must not silently wipe a corrupt file.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const HISTORY_FILE_NAME: &str = "history.json";

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join(HISTORY_FILE_NAME))
}

/// Read raw history JSON. Returns `null` when the file does not exist.
#[tauri::command]
pub fn history_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = history_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read history.json: {e}"))?;
    Ok(Some(raw))
}

/// Atomically replace `history.json` with `contents`.
#[tauri::command]
pub fn history_save(app: AppHandle, contents: String) -> Result<(), String> {
    let path = history_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents.as_bytes())
        .map_err(|e| format!("write history.json.tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename history.json.tmp: {e}")
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
        std::env::temp_dir().join(format!("voxloom-history-test-{nanos}"))
    }

    #[test]
    fn atomic_save_round_trip() {
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(HISTORY_FILE_NAME);
        let tmp = path.with_extension("json.tmp");
        let body = "{\"version\":1,\"records\":[]}\n";
        fs::write(&tmp, body).unwrap();
        fs::rename(&tmp, &path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        let _ = fs::remove_dir_all(&dir);
    }
}
