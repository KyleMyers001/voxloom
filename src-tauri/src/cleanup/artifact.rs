use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

#[derive(Clone, Copy)]
pub struct ArtifactSpec {
    pub sha256: &'static str,
    pub size: u64,
}

pub fn copy_private(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = File::open(source)
        .map_err(|error| format!("open imported model: {error}"))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| format!("create partial model: {error}"))?;
    std::io::copy(&mut input, &mut output)
        .map_err(|error| format!("copy imported model: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("flush imported model: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("sync imported model: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("protect imported model: {error}"))?;
    }
    Ok(())
}

pub fn validate(path: &Path, spec: ArtifactSpec) -> Result<(), String> {
    validate_shape(path, spec)?;
    let mut file = File::open(path)
        .map_err(|error| format!("open cleanup model: {error}"))?;
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
    Ok(())
}

pub fn validate_shape(path: &Path, spec: ArtifactSpec) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("read cleanup model metadata: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("cleanup model must be a regular non-symlink file".into());
    }
    if metadata.len() != spec.size {
        return Err(format!(
            "cleanup model size mismatch: expected {}, got {}",
            spec.size,
            metadata.len(),
        ));
    }
    let mut file = File::open(path)
        .map_err(|error| format!("open cleanup model: {error}"))?;
    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)
        .map_err(|error| format!("read GGUF header: {error}"))?;
    if &magic != b"GGUF" {
        return Err("cleanup model is not a GGUF file".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(bytes: &'static [u8]) -> ArtifactSpec {
        let digest =
            Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str());
        ArtifactSpec {
            sha256: digest,
            size: bytes.len() as u64,
        }
    }

    #[test]
    fn validates_header_size_and_digest() {
        let path = std::env::temp_dir().join(format!(
            "voxloom-artifact-valid-{}.gguf",
            std::process::id(),
        ));
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
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir()
            .join(format!("voxloom-artifact-symlink-{}", std::process::id(),));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
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
