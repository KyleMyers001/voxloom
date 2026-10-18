//! Preserve an on-disk store file the frontend could not read (corrupt or
//! unknown/older schema version) before anything is allowed to replace it.
//!
//! Copies `app_data_dir/<store>.json` to
//! `app_data_dir/<store>.json.unreadable-<unix-ms>.bak`. Never deletes or
//! modifies the original. BUS-42.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
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

/// Highest `-N` suffix tried when backup names collide; past it, fail safely.
const MAX_SUFFIX: u32 = 100;

/// Newest existing `<name>.unreadable-*.bak` next to `path`, by mtime.
fn newest_backup(path: &Path, name: &str) -> Option<PathBuf> {
    let dir = path.parent()?;
    let prefix = format!("{name}.unreadable-");
    fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            n.starts_with(&prefix) && n.ends_with(".bak")
        })
        // symlink_metadata: never follow a planted link when comparing.
        .filter_map(|e| {
            let meta = fs::symlink_metadata(e.path()).ok()?;
            meta.is_file().then(|| (meta.modified().ok(), e.path()))
        })
        .max_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)))
        .map(|(_, p)| p)
}

/// Copy `path` to a new backup next to it. `Ok(None)` when the source does
/// not exist. When the newest backup already holds identical bytes, that
/// backup is returned instead of taking another copy (a file that stays
/// unreadable across launches is backed up once).
///
/// The backup is created with `create_new` (O_EXCL): it never overwrites an
/// existing file and never follows a symlink planted at the backup name. On
/// a name collision the next `-N` suffix is tried, up to `MAX_SUFFIX`.
pub(crate) fn backup_file(path: &Path, now_ms: u128) -> Result<Option<PathBuf>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid store path".to_string())?;
    let contents = fs::read(path).map_err(|e| format!("read {name} for backup: {e}"))?;
    if let Some(existing) = newest_backup(path, name) {
        if fs::read(&existing).ok().as_deref() == Some(contents.as_slice()) {
            return Ok(Some(existing));
        }
    }
    for n in 0..=MAX_SUFFIX {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = path.with_file_name(format!("{name}.unreadable-{now_ms}{suffix}.bak"));
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("create backup for {name}: {e}")),
        };
        if let Err(e) = file.write_all(&contents).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&candidate);
            return Err(format!("write backup for {name}: {e}"));
        }
        return Ok(Some(candidate));
    }
    Err(format!("backup for {name}: too many name collisions"))
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
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        assert_eq!(fs::read_to_string(&first).unwrap(), body);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn identical_unreadable_file_is_backed_up_once() {
        let dir = temp_dir();
        let path = dir.join("history.json");
        fs::write(&path, "{\"version\":99}").unwrap();
        let first = backup_file(&path, 1).unwrap().unwrap();
        let again = backup_file(&path, 2).unwrap().unwrap();
        assert_eq!(first, again);
        fs::write(&path, "{\"version\":100}").unwrap();
        let changed = backup_file(&path, 3).unwrap().unwrap();
        assert_ne!(first, changed);
        assert_eq!(fs::read_to_string(&changed).unwrap(), "{\"version\":100}");
        let count = fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".bak")
            })
            .count();
        assert_eq!(count, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn name_collision_never_overwrites_existing_backup() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        fs::write(&path, "new").unwrap();
        let taken = dir.join("settings.json.unreadable-7.bak");
        fs::write(&taken, "older unrelated").unwrap();
        let backup = backup_file(&path, 7).unwrap().unwrap();
        assert_eq!(backup, dir.join("settings.json.unreadable-7-1.bak"));
        assert_eq!(fs::read_to_string(&taken).unwrap(), "older unrelated");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "new");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn planted_symlink_is_not_followed() {
        let dir = temp_dir();
        let path = dir.join("history.json");
        fs::write(&path, "secret-history").unwrap();
        let victim = dir.join("victim.txt");
        fs::write(&victim, "do not touch").unwrap();
        let planted = dir.join("history.json.unreadable-9.bak");
        std::os::unix::fs::symlink(&victim, &planted).unwrap();
        let backup = backup_file(&path, 9).unwrap().unwrap();
        assert_ne!(backup, planted);
        assert_eq!(fs::read_to_string(&victim).unwrap(), "do not touch");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "secret-history");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_utf8_is_copied_byte_for_byte() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let bytes: &[u8] = &[b'{', 0xff, 0xfe, 0x80, b'}'];
        fs::write(&path, bytes).unwrap();
        let backup = backup_file(&path, 5).unwrap().unwrap();
        assert_eq!(fs::read(&backup).unwrap(), bytes);
        assert_eq!(fs::read(&path).unwrap(), bytes);
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
