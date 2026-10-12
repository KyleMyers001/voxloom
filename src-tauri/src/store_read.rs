//! Shared raw read for the JSON stores (settings, history, dictionary).
//!
//! Only a path that truly does not exist is a first launch (`Ok(None)`).
//! A directory or other non-regular file at the store path, or a path whose
//! metadata cannot be read (e.g. an unreadable parent folder), is an error,
//! so the frontend runs its read-error path: backup attempt, writes blocked
//! unless a real backup was made (BUS-42).

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

pub(crate) fn read_store(path: &Path, name: &str) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("stat {name}: {e}")),
        Ok(meta) if meta.file_type().is_symlink() => {
            // Follow a symlink only to a regular file.
            match fs::metadata(path) {
                Ok(t) if t.is_file() => {}
                Ok(_) => return Err(format!("read {name}: not a regular file")),
                Err(e) => return Err(format!("stat {name}: {e}")),
            }
        }
        Ok(meta) if !meta.is_file() => {
            return Err(format!("read {name}: not a regular file"));
        }
        Ok(_) => {}
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|e| format!("read {name}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("voxloom-read-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_is_first_launch() {
        let dir = temp_dir("missing");
        assert_eq!(
            read_store(&dir.join("settings.json"), "settings.json"),
            Ok(None)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn regular_file_is_read() {
        let dir = temp_dir("file");
        let path = dir.join("history.json");
        fs::write(&path, "{}").unwrap();
        assert_eq!(read_store(&path, "history.json"), Ok(Some("{}".into())));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn directory_at_path_is_an_error() {
        let dir = temp_dir("dir");
        let path = dir.join("settings.json");
        fs::create_dir_all(&path).unwrap();
        let err = read_store(&path, "settings.json").unwrap_err();
        assert!(err.contains("not a regular file"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_utf8_is_an_error() {
        let dir = temp_dir("utf8");
        let path = dir.join("dictionary.json");
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_store(&path, "dictionary.json").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_folder_is_an_error_not_first_launch() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perm");
        let inner = dir.join("app");
        fs::create_dir_all(&inner).unwrap();
        let path = inner.join("settings.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&inner, fs::Permissions::from_mode(0o000)).unwrap();
        let result = read_store(&path, "settings.json");
        // Root ignores permission bits; only assert when access is denied.
        let denied = fs::read(&path).is_err();
        fs::set_permissions(&inner, fs::Permissions::from_mode(0o755)).unwrap();
        if denied {
            assert!(result.is_err(), "{result:?}");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
