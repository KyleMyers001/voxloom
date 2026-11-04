//! The one pinned cleanup model (BUS-16, BUS-181): Qwen3 0.6B Q4_K_M GGUF.
//!
//! Import and the one-click download accept exactly these bytes. The download
//! URL is pinned to an immutable Hugging Face commit of
//! `unsloth/Qwen3-0.6B-GGUF`; the SHA-256 is that file's LFS oid there.
//! Qwen3 by Alibaba Cloud (Qwen team), Apache-2.0; GGUF by Unsloth.

pub const MODEL_ID: &str = "qwen3-0.6b-q4-k-m";
pub(super) const MODEL_FILE: &str = "qwen3-0.6b-q4-k-m.gguf";
pub(super) const MODEL_SHA256: &str =
    "ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a";
pub(super) const MODEL_SIZE: u64 = 396_705_472;

/// Pinned `unsloth/Qwen3-0.6B-GGUF` commit. Changing it means re-reading the
/// file's size and LFS oid at the new commit.
#[allow(dead_code)] // Read by the pin test; documents MODEL_URL.
pub(super) const MODEL_REVISION: &str = "50968a4468ef4233ed78cd7c3de230dd1d61a56b";
pub(super) const MODEL_URL: &str = "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/50968a4468ef4233ed78cd7c3de230dd1d61a56b/Qwen3-0.6B-Q4_K_M.gguf";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_is_pinned_to_the_revision_and_file() {
        assert!(MODEL_URL.starts_with("https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/"));
        assert!(MODEL_URL.contains(&format!("/resolve/{MODEL_REVISION}/")));
        assert!(MODEL_URL.ends_with("/Qwen3-0.6B-Q4_K_M.gguf"));
        assert_eq!(MODEL_REVISION.len(), 40);
        assert_eq!(MODEL_SHA256.len(), 64);
        assert!(MODEL_SHA256
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(MODEL_SIZE, 396_705_472);
    }
}
