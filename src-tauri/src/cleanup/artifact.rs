use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug)]
pub struct ArtifactSpec {
    pub sha256: &'static str,
    pub size: u64,
}

pub fn copy_private(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = open_regular(source)?;
    copy_private_from(&mut input, destination)
}

fn copy_private_from(input: &mut impl Read, destination: &Path) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Privacy applies while copying, not just after the file is complete.
        options.mode(0o600);
    }
    let mut output = options
        .open(destination)
        .map_err(|error| format!("create partial model: {error}"))?;
    std::io::copy(input, &mut output).map_err(|error| format!("copy imported model: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("flush imported model: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("sync imported model: {error}"))?;
    Ok(())
}

pub fn validate(path: &Path, spec: ArtifactSpec) -> Result<(), String> {
    // Shape, magic, and hash all use the same no-follow descriptor; an earlier
    // pathname-only shape pass would add a racy, potentially blocking open.
    open_verified(path, spec).map(drop)
}

pub fn open_verified(path: &Path, spec: ArtifactSpec) -> Result<File, String> {
    let mut file = open_regular(path)?;
    validate_file(&mut file, spec)?;
    Ok(file)
}

pub fn open_regular(path: &Path) -> Result<File, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("read cleanup model metadata: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("cleanup model must be a regular non-symlink file".into());
    }
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            // NONBLOCK also prevents a regular-file-to-FIFO swap from hanging
            // admission between lstat and open. Check the opened descriptor.
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
    };
    #[cfg(not(unix))]
    let file = File::open(path);
    let file = file.map_err(|error| format!("open cleanup model: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("cleanup model must be a regular file".into());
    }
    Ok(file)
}

pub fn validate_file(file: &mut File, spec: ArtifactSpec) -> Result<(), String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("rewind cleanup model: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("read cleanup model metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() != spec.size {
        return Err(format!(
            "cleanup model size mismatch: expected {}, got {}",
            spec.size,
            metadata.len(),
        ));
    }
    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)
        .map_err(|error| format!("read GGUF header: {error}"))?;
    if &magic != b"GGUF" {
        return Err("cleanup model is not a GGUF file".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("rewind cleanup model: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("hash cleanup model: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    if format!("{:x}", hasher.finalize()) != spec.sha256 {
        return Err("cleanup model SHA-256 mismatch".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("rewind cleanup model: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(bytes: &'static [u8]) -> ArtifactSpec {
        let digest = Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
        ArtifactSpec {
            sha256: digest,
            size: bytes.len() as u64,
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        #[cfg(unix)]
        let root = crate::cleanup::test_support::test_root().join(format!("artifact-{name}"));
        #[cfg(not(unix))]
        let root =
            std::env::temp_dir().join(format!("voxloom-artifact-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn validates_header_size_and_digest() {
        let root = scratch("valid");
        let path = root.join("sample.gguf");
        fs::write(&path, b"GGUFtest").unwrap();
        assert!(validate(&path, spec(b"GGUFtest")).is_ok());
        assert!(validate(
            &path,
            ArtifactSpec {
                sha256: "",
                size: 9,
            }
        )
        .unwrap_err()
        .contains("size mismatch"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn partial_is_private_before_the_first_byte_is_copied() {
        use std::os::unix::fs::PermissionsExt;
        struct Inspect<'a>(&'a Path);
        impl Read for Inspect<'_> {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                assert_eq!(
                    fs::metadata(self.0)?.permissions().mode() & 0o077,
                    0,
                    "partial must not grant group/other access during copying"
                );
                Ok(0)
            }
        }
        let root = scratch("partial-private");
        let destination = root.join("new.partial");
        copy_private_from(&mut Inspect(&destination), &destination).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn copying_rejects_symlink_sources_and_existing_destinations() {
        use std::os::unix::fs::symlink;
        let root = scratch("copy-private");
        let source = root.join("source");
        let link = root.join("link");
        let destination = root.join("partial");
        fs::write(&source, b"GGUFtest").unwrap();
        symlink(&source, &link).unwrap();
        assert!(copy_private(&link, &destination).is_err());
        assert!(!destination.exists());
        fs::write(&destination, b"keep existing").unwrap();
        assert!(copy_private(&source, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"keep existing");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks() {
        use std::os::unix::fs::symlink;
        let root = scratch("symlink");
        let real = root.join("real.gguf");
        let link = root.join("link.gguf");
        fs::write(&real, b"GGUFtest").unwrap();
        symlink(&real, &link).unwrap();
        assert!(validate(&link, spec(b"GGUFtest"))
            .unwrap_err()
            .contains("regular"));
        let _ = fs::remove_dir_all(root);
    }
}
