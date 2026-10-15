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

/// Read raw history JSON. Returns `null` only when the file does not exist;
/// a directory or unreadable path is an error (BUS-42).
#[tauri::command]
pub fn history_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = history_path(&app)?;
    let raw = crate::store_read::read_store(&path, "history.json")?;
    remove_orphaned_tmp(&path, raw.as_deref());
    Ok(raw)
}

/// Delete a `history.json.tmp` left by a crash between write and rename
/// (BUS-78). Conservative: only when `history.json` itself read back as valid
/// JSON, so a tmp that might be the only good copy (main file missing or
/// damaged) is left for the user to recover.
fn remove_orphaned_tmp(path: &std::path::Path, loaded: Option<&str>) -> bool {
    let Some(body) = loaded else { return false };
    if serde_json::from_str::<serde_json::Value>(body).is_err() {
        return false;
    }
    let tmp = path.with_extension("json.tmp");
    match fs::symlink_metadata(&tmp) {
        Ok(meta) if meta.is_file() => fs::remove_file(&tmp).is_ok(),
        _ => false,
    }
}

/// Atomically replace `history.json` with `contents`.
#[tauri::command]
pub fn history_save(app: AppHandle, contents: String) -> Result<(), String> {
    let path = history_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents.as_bytes()).map_err(|e| format!("write history.json.tmp: {e}"))?;
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

    #[test]
    fn orphaned_tmp_removed_only_when_main_file_is_valid() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(HISTORY_FILE_NAME);
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, "{\"version\":1,\"records\":[]}").unwrap();
        // Main file missing: tmp may be the only copy, keep it.
        assert!(!remove_orphaned_tmp(&path, None));
        assert!(tmp.exists());
        // Main file damaged: keep tmp too.
        assert!(!remove_orphaned_tmp(&path, Some("{not json")));
        assert!(tmp.exists());
        // Main file valid: the tmp is a stale orphan, delete it.
        assert!(remove_orphaned_tmp(
            &path,
            Some("{\"version\":1,\"records\":[]}")
        ));
        assert!(!tmp.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
