use std::path::{Path, PathBuf};
pub const NAME: &str = "voxloom-parakeet-worker";
pub fn resolve(exe: Option<&Path>, source: &Path, target: &str, development: bool) -> PathBuf {
    if let Some(sibling) = exe
        .and_then(Path::parent)
        .map(|dir| dir.join(NAME))
        .filter(|p| p.is_file())
    {
        return sibling;
    }
    if !development {
        return PathBuf::new();
    }
    let packaged = source.join("binaries").join(format!("{NAME}-{target}"));
    if packaged.is_file() {
        return packaged;
    }
    source.join("parakeet-worker/.build/release").join(NAME)
}
pub fn installed() -> PathBuf {
    let exe = std::env::current_exe().ok();
    resolve(
        exe.as_deref(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
        if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        },
        cfg!(debug_assertions),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_sibling_wins_and_release_never_uses_source_or_environment() {
        let root = std::env::temp_dir().join(format!("parakeet-resolver-{}", std::process::id()));
        std::fs::create_dir_all(root.join("binaries")).unwrap();
        std::fs::write(root.join(NAME), b"").unwrap();
        let exe = root.join("voxloom");
        assert_eq!(
            resolve(Some(&exe), &root, "aarch64-apple-darwin", false),
            root.join(NAME)
        );
        std::fs::remove_file(root.join(NAME)).unwrap();
        assert_eq!(
            resolve(Some(&exe), &root, "aarch64-apple-darwin", false),
            PathBuf::new()
        );
        let packaged = root
            .join("binaries")
            .join(format!("{NAME}-aarch64-apple-darwin"));
        std::fs::write(&packaged, b"").unwrap();
        assert_eq!(
            resolve(Some(&exe), &root, "aarch64-apple-darwin", true),
            packaged
        );
        std::fs::remove_file(packaged).unwrap();
        assert_eq!(
            resolve(None, &root, "aarch64-apple-darwin", true),
            root.join("parakeet-worker/.build/release").join(NAME)
        );
    }
}
