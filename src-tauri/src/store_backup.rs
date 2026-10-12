//! Preserve an on-disk store file the frontend could not read (corrupt or
//! unknown/older schema version) before anything is allowed to replace it.
//!
//! Copies `app_data_dir/<store>.json` to
//! `app_data_dir/<store>.json.unreadable-<unix-ms>.bak`. Never deletes or
//! modifies the original. BUS-42.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

fn file_name_for(store: &str) -> Result<&'static str, String> {
    match store {
        "dictionary" => Ok("dictionary.json"),
        "history" => Ok("history.json"),
        "settings" => Ok("settings.json"),
        other => Err(format!("unknown store: {other}")),
    }
}

/// Copy `path` to a unique backup next to it. `Ok(None)` when the source
/// does not exist (nothing to preserve).
pub(crate) fn backup_file(path: &Path, now_ms: u128) -> Result<Option<PathBuf>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid store path".to_string())?;
    let mut n = 0u32;
    let backup = loop {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = path.with_file_name(format!("{name}.unreadable-{now_ms}{suffix}.bak"));
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
    };
    fs::copy(path, &backup).map_err(|e| format!("backup {name}: {e}"))?;
    Ok(Some(backup))
}

/// Back up an unreadable store file. Returns the backup path, or `null`
/// when there was no file.
#[tauri::command]
pub fn store_backup(app: AppHandle, store: String) -> Result<Option<String>, String> {
    let file = file_name_for(&store)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(backup_file(&dir.join(file), now_ms)?.map(|p| p.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("voxloom-backup-test-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn backup_copies_without_touching_original() {
        let dir = temp_dir();
        let path = dir.join("history.json");
        let body = "{\"version\":3,\"records\":[{\"id\":\"x\"}]}\n";
        fs::write(&path, body).unwrap();
        let first = backup_file(&path, 42).unwrap().unwrap();
        let second = backup_file(&path, 42).unwrap().unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        assert_eq!(fs::read_to_string(&first).unwrap(), body);
        assert_eq!(fs::read_to_string(&second).unwrap(), body);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_of_missing_file_is_none() {
        let dir = temp_dir();
        assert!(backup_file(&dir.join("history.json"), 1).unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_store_rejected() {
        assert!(file_name_for("../etc/passwd").is_err());
    }
}
