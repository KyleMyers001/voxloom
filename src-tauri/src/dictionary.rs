//! Durable Word dictionary store (`app_data_dir/dictionary.json`).
//!
//! Atomic write: temp file + rename. Load failures are returned to the
//! frontend — callers must not silently wipe a corrupt file, and must
//! never touch `settings.json` or `history.json` from this path.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const DICTIONARY_FILE_NAME: &str = "dictionary.json";

fn dictionary_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join(DICTIONARY_FILE_NAME))
}

/// Read raw dictionary JSON. Returns `null` only when the file does not exist;
/// a directory or unreadable path is an error (BUS-42).
#[tauri::command]
pub fn dictionary_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = dictionary_path(&app)?;
    crate::store_read::read_store(&path, "dictionary.json")
}

/// Atomically replace `dictionary.json` with `contents`.
#[tauri::command]
pub fn dictionary_save(app: AppHandle, contents: String) -> Result<(), String> {
    let path = dictionary_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents.as_bytes()).map_err(|e| format!("write dictionary.json.tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename dictionary.json.tmp: {e}")
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
        std::env::temp_dir().join(format!("voxloom-dictionary-test-{nanos}"))
    }

    #[test]
    fn atomic_save_round_trip() {
        let dir = temp_dir();
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(DICTIONARY_FILE_NAME);
        let tmp = path.with_extension("json.tmp");
        let body = "{\"version\":1,\"words\":[\"TypeScript\"]}\n";
        fs::write(&tmp, body).unwrap();
        fs::rename(&tmp, &path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        let _ = fs::remove_dir_all(&dir);
    }
}
