//! Complete, revision-pinned Core ML sets for the local-only FluidAudio loader.

#[cfg(test)]
mod tests {
    #[test]
    fn requires_native_apple_silicon_and_macos_14() {
        assert!(super::supports_platform("macos", "aarch64", 14));
        assert!(super::supports_platform("macos", "aarch64", 27));
        assert!(!super::supports_platform("macos", "aarch64", 13));
        assert!(!super::supports_platform("macos", "x86_64", 27));
        assert!(!super::supports_platform("linux", "aarch64", 27));
    }

    #[test]
    fn both_versions_have_complete_pinned_sets() {
        for version in ["v2", "v3"] {
            let id = format!("parakeet-tdt-0.6b-{version}");
            let spec = super::find(&id).expect("Parakeet model must be catalogued");
            assert_eq!(spec.version, version);
            assert_eq!(spec.files.len(), 21);
            assert_eq!(
                spec.size_bytes,
                spec.files.iter().map(|f| f.size_bytes).sum::<u64>()
            );
            let joint = if version == "v3" {
                "JointDecisionv3.mlmodelc/"
            } else {
                "JointDecision.mlmodelc/"
            };
            for component in [
                "Encoder.mlmodelc/",
                "Decoder.mlmodelc/",
                "Preprocessor.mlmodelc/",
                joint,
            ] {
                assert_eq!(
                    spec.files
                        .iter()
                        .filter(|f| f.path.starts_with(component))
                        .count(),
                    5
                );
            }
            assert!(spec.files.iter().any(|f| f.path == "parakeet_vocab.json"));
            for file in spec.files {
                assert!(file.size_bytes > 0);
                assert_eq!(file.sha256.len(), 64);
                assert!(file.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
                assert!(!file.path.starts_with('/'));
                assert!(!file.path.split('/').any(|c| c == ".."));
                assert!(spec.url(file).contains(spec.revision));
            }
        }
        assert!(super::find("whisper-tiny.en").is_none());
    }

    #[test]
    fn vocabulary_set_is_complete_pinned_and_not_a_model() {
        let spec = super::VOCABULARY;
        assert_eq!(spec.files.len(), 12);
        assert_eq!(
            spec.size_bytes,
            spec.files.iter().map(|f| f.size_bytes).sum::<u64>()
        );
        for component in ["AudioEncoder.mlmodelc/", "MelSpectrogram.mlmodelc/"] {
            assert_eq!(
                spec.files
                    .iter()
                    .filter(|f| f.path.starts_with(component))
                    .count(),
                5
            );
        }
        for path in ["tokenizer.json", "vocab.json"] {
            assert!(spec.files.iter().any(|f| f.path == path));
        }
        for file in spec.files {
            assert!(file.size_bytes > 0);
            assert_eq!(file.sha256.len(), 64);
            assert!(file.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
            assert!(!file.path.starts_with('/'));
            assert!(!file.path.split('/').any(|c| c == ".."));
        }
        assert_eq!(
            spec.url(&spec.files[0]),
            "https://huggingface.co/FluidInference/parakeet-ctc-110m-coreml/resolve/\
             accdafd8cf8a2ff1cabe3c11e54416b405d409aa/AudioEncoder.mlmodelc/analytics/coremldata.bin"
        );
        assert!(super::find(spec.id).is_none());
        assert!(super::CATALOG.iter().all(|model| model.id != spec.id));
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ParakeetFile {
    pub path: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
}
#[derive(Debug, Clone, Copy)]
pub struct ParakeetModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub version: &'static str,
    pub size_bytes: u64,
    pub revision: &'static str,
    pub files: &'static [ParakeetFile],
}
impl ParakeetFile {
    pub fn artifact(&self) -> crate::model_fetch::PinnedArtifact {
        crate::model_fetch::PinnedArtifact {
            size_bytes: self.size_bytes,
            sha256: self.sha256,
        }
    }
}
impl ParakeetModelSpec {
    pub fn url(&self, file: &ParakeetFile) -> String {
        format!(
            "https://huggingface.co/FluidInference/{}-coreml/resolve/{}/{}",
            self.id, self.revision, file.path
        )
    }
}

/// Runtime loader contract reviewed at this exact FluidAudio commit.
#[allow(dead_code)]
pub const FLUID_AUDIO_REVISION: &str = "ee78635d23d52379117554ba72358b65a0612447";
include!("parakeet-manifests/v2.rs");
include!("parakeet-manifests/v3.rs");
include!("parakeet-manifests/ctc110m.rs");
pub const CATALOG: &[ParakeetModelSpec] = &[
    ParakeetModelSpec {
        id: "parakeet-tdt-0.6b-v2",
        label: "Parakeet v2 (English)",
        version: "v2",
        revision: "ee09c569f73759e6d44c9bd16766f477b2b36d39",
        size_bytes: 464_413_247,
        files: V2_FILES,
    },
    ParakeetModelSpec {
        id: "parakeet-tdt-0.6b-v3",
        label: "Parakeet v3 (Multilingual)",
        version: "v3",
        revision: "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe",
        size_bytes: 483_105_645,
        files: V3_FILES,
    },
];
/// FluidAudio's CTC keyword spotter, which applies the Word dictionary to
/// Parakeet transcripts. One copy serves both models; it is fetched with
/// whichever is downloaded first and is not a model to pick.
pub const VOCABULARY: ParakeetModelSpec = ParakeetModelSpec {
    id: "parakeet-ctc-110m",
    label: "Parakeet dictionary boosting",
    version: "ctc",
    revision: "accdafd8cf8a2ff1cabe3c11e54416b405d409aa",
    size_bytes: 102_802_455,
    files: CTC_110M_FILES,
};
fn supports_platform(os: &str, arch: &str, major: i64) -> bool {
    os == "macos" && arch == "aarch64" && major >= 14
}

pub const UNAVAILABLE_REASON: &str = "Parakeet requires Apple Silicon and macOS 14 or later.";

pub fn is_supported() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        supports_platform("macos", "aarch64", version.majorVersion as i64)
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        false
    }
}

pub fn find(model_id: &str) -> Option<&'static ParakeetModelSpec> {
    CATALOG.iter().find(|spec| spec.id == model_id)
}
