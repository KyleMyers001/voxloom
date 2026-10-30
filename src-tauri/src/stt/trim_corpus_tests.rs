//! BUS-143: the committed corpus (fixtures/trim_corpus, see its README) run
//! through the trim, with no model, on every CI run.
//!
//! - `trailoff` clips end in soft speech with nothing after it, so the whole
//!   clip must be kept. At ff8de7a the trim cut 0.8–1.5 s of five of them.
//! - `halluc` clips are speech and 2.5 s of room noise: the trim must keep
//!   the speech and no more than the usual tail, or "Thank you." returns.
//!   (`trim_corpus_model_tests` checks the same clips with a real model.)

use super::{trailing_trim, KEPT_TAIL_MS};

const RATE: u32 = 16_000;
/// Two 20 ms frames: what a clip that ends in speech may lose.
const END_SLACK: usize = 640;

#[derive(PartialEq)]
pub(super) enum Kind {
    TrailOff,
    Halluc,
}

pub(super) struct Clip {
    pub name: String,
    pub kind: Kind,
    /// A word the model hears on the untrimmed clip (`trailoff` only).
    #[cfg_attr(not(feature = "whisper"), allow(dead_code))]
    pub word: String,
    pub samples: Vec<f32>,
    pub speech_end: usize,
}

pub(super) fn corpus() -> Vec<Clip> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/stt/fixtures/trim_corpus");
    let manifest = std::fs::read_to_string(dir.join("manifest.tsv")).unwrap();
    let clips: Vec<Clip> = manifest
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            let bytes = std::fs::read(dir.join(f[0])).unwrap();
            Clip {
                name: f[0].to_owned(),
                kind: if f[1] == "trailoff" {
                    Kind::TrailOff
                } else {
                    Kind::Halluc
                },
                word: f[2].to_owned(),
                samples: (bytes.as_chunks::<2>().0.iter())
                    .map(|&b| f32::from(i16::from_le_bytes(b)) / 32_768.0)
                    .collect(),
                speech_end: f[3].parse().unwrap(),
            }
        })
        .collect();
    assert_eq!(clips.len(), 11, "manifest lists every fixture");
    clips
}

#[test]
fn trail_off_clips_keep_all_of_their_speech() {
    for clip in corpus().iter().filter(|c| c.kind == Kind::TrailOff) {
        let keep = trailing_trim(&clip.samples, RATE).keep_len;
        assert!(
            keep + END_SLACK >= clip.samples.len(),
            "{}: kept {keep} of {}",
            clip.name,
            clip.samples.len()
        );
    }
}

#[test]
fn hallucination_clips_keep_the_speech_and_only_the_usual_tail() {
    let tail = RATE as usize * KEPT_TAIL_MS / 1000;
    for clip in corpus().iter().filter(|c| c.kind == Kind::Halluc) {
        let keep = trailing_trim(&clip.samples, RATE).keep_len;
        assert!(
            keep >= clip.speech_end,
            "{}: cut speech, kept {keep}",
            clip.name
        );
        assert!(
            keep <= clip.speech_end + tail + END_SLACK,
            "{}: kept {keep} for speech ending at {}",
            clip.name,
            clip.speech_end
        );
    }
}
