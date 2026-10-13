//! Download integrity checks (BUS-35): byte count against Content-Length and
//! SHA-256 against the catalog pin. Both run before the `.partial` is renamed
//! into place, so a model reported "available" is always a verified file.

use sha2::{Digest, Sha256};

use crate::stt::catalog::ModelSpec;
use crate::stt::error::SttErrorDto;

/// Streaming SHA-256 + byte counter fed while bytes are written.
#[derive(Default)]
pub(super) struct Integrity {
    hasher: Sha256,
    received: u64,
}

impl Integrity {
    pub(super) fn update(&mut self, chunk: &[u8]) {
        self.hasher.update(chunk);
        self.received += chunk.len() as u64;
    }

    pub(super) fn received(&self) -> u64 {
        self.received
    }

    /// Fail on a short (or long) body when the server declared a length, then
    /// on a hash that does not match `spec.sha256`.
    pub(super) fn finish(self, spec: &ModelSpec, declared: Option<u64>) -> Result<(), SttErrorDto> {
        check_length(self.received, declared)?;
        let actual = hex(&self.hasher.finalize());
        check_sha256(spec, &actual)
    }
}

pub(super) fn check_length(received: u64, declared: Option<u64>) -> Result<(), SttErrorDto> {
    match declared {
        Some(want) if want != received => Err(SttErrorDto::new(
            "download-failed",
            format!("Download incomplete: received {received} of {want} bytes"),
        )),
        _ => Ok(()),
    }
}

pub(super) fn check_sha256(spec: &ModelSpec, actual: &str) -> Result<(), SttErrorDto> {
    if actual.eq_ignore_ascii_case(spec.sha256) {
        return Ok(());
    }
    Err(SttErrorDto::new(
        "download-failed",
        format!(
            "Checksum mismatch for {}: expected {}, got {actual}. The file was deleted.",
            spec.id, spec.sha256
        ),
    ))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::catalog;

    #[test]
    fn known_vector_matches() {
        let spec = ModelSpec {
            // sha256("abc")
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ..*catalog::find("whisper-tiny.en").unwrap()
        };
        let mut i = Integrity::default();
        i.update(b"ab");
        i.update(b"c");
        assert_eq!(i.received(), 3);
        assert!(i.finish(&spec, Some(3)).is_ok());
    }

    #[test]
    fn mismatch_and_short_reads_fail() {
        let spec = catalog::find("whisper-tiny.en").unwrap();
        let mut i = Integrity::default();
        i.update(b"not a model");
        let err = i.finish(spec, None).unwrap_err();
        assert_eq!(err.code, "download-failed");
        assert!(err.message.contains("Checksum mismatch"), "{}", err.message);

        let err = check_length(10, Some(11)).unwrap_err();
        assert!(err.message.contains("incomplete"));
        assert!(check_length(10, None).is_ok());
    }
}
