//! BUS-139: trim the quiet tail of a clip before whisper.
//!
//! Whisper hallucinates "Thank you." or "you" over the silence or room noise
//! left after the last word. The trailing run of quiet 20 ms frames is cut
//! down to a short kept tail. "Quiet" is relative to the clip's own speech
//! level, with an absolute floor, so a mic with a higher noise floor still
//! trims when the speech is much louder. The speech end is the last run of
//! at least 60 ms of loud frames, so a click or key thump at the very end
//! doesn't count as speech.

use super::gate::AudioStats;

const FRAME_MS: usize = 20;
/// Tail kept after the speech end. Whisper drops a short final word ("okay",
/// "thanks") that ends 250–500 ms before the clip end; at 1000 ms "Thank
/// you" comes back. 750 ms kept every final word in the QA tail sweep.
const KEPT_TAIL_MS: usize = 750;
/// Loud frames in a row needed to count as speech for the speech end.
const MIN_SPEECH_FRAMES: usize = 3;
/// Frames at or above this RMS (≈ −44 dBFS) may be speech. Hallucinated
/// tails measured 0.0000–0.0011 RMS in the BUS-139 harness.
const ABSOLUTE_FLOOR_RMS: f32 = 0.006;
/// Speech level: this percentile of the possible-speech frames.
const SPEECH_PERCENTILE: f32 = 0.9;
/// Quiet is below this fraction (≈ −30 dB) of the speech level, so a final
/// word up to about 30 dB softer than the dictation is kept. Hallucinated
/// tails measured ≤ 0.0011 RMS; at typical levels the 0.006 floor decides.
const RELATIVE_FACTOR: f32 = 0.03;

/// What `trailing_trim` decided for one clip.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TailTrim {
    /// Samples to keep from the start of the clip.
    pub keep_len: usize,
    /// RMS of the trailing quiet run (0 when there is none).
    pub tail_rms: f32,
    /// Frame RMS below which the tail counted as quiet.
    pub threshold: f32,
}

impl TailTrim {
    /// Milliseconds removed from a clip of `total_len` samples. Only the
    /// debug-build log uses it, so it is not compiled into release.
    #[cfg(any(debug_assertions, test))]
    pub fn trimmed_ms(&self, total_len: usize, sample_rate_hz: u32) -> u64 {
        let removed = total_len.saturating_sub(self.keep_len) as u64;
        removed * 1000 / u64::from(sample_rate_hz.max(1))
    }
}

/// Decide how much of `samples` to keep. Clips with no frame above the
/// absolute floor, or with a quiet tail no longer than the kept tail, are
/// left unchanged. Never trims to empty.
pub fn trailing_trim(samples: &[f32], sample_rate_hz: u32) -> TailTrim {
    let ms = |n: usize| (sample_rate_hz as usize * n / 1000).max(1);
    let frame = ms(FRAME_MS);
    let levels: Vec<f32> = samples
        .chunks(frame)
        .map(|f| AudioStats::measure(f).rms)
        .collect();
    let Some(speech) = speech_level(&levels) else {
        return TailTrim {
            keep_len: samples.len(),
            tail_rms: 0.0,
            threshold: ABSOLUTE_FLOOR_RMS,
        };
    };
    let threshold = (speech * RELATIVE_FACTOR).max(ABSOLUTE_FLOOR_RMS);
    let Some(end_frame) = speech_end(&levels, threshold) else {
        return TailTrim {
            keep_len: samples.len(),
            tail_rms: 0.0,
            threshold,
        };
    };
    let quiet_start = (end_frame * frame).min(samples.len());
    let tail_rms = if quiet_start == samples.len() {
        0.0
    } else {
        AudioStats::measure(&samples[quiet_start..]).rms
    };
    TailTrim {
        keep_len: (quiet_start + ms(KEPT_TAIL_MS)).min(samples.len()),
        tail_rms,
        threshold,
    }
}

/// Frame index just past the last run of `MIN_SPEECH_FRAMES` or more frames
/// at or above `threshold`. `None` when there is no such run.
fn speech_end(levels: &[f32], threshold: f32) -> Option<usize> {
    let mut run = 0;
    for (i, &r) in levels.iter().enumerate().rev() {
        if r < threshold {
            run = 0;
            continue;
        }
        run += 1;
        if run == MIN_SPEECH_FRAMES {
            return Some(i + run);
        }
    }
    None
}

/// The given percentile of the frames at or above the absolute floor.
fn speech_level(levels: &[f32]) -> Option<f32> {
    let mut loud: Vec<f32> = levels
        .iter()
        .copied()
        .filter(|&r| r >= ABSOLUTE_FLOOR_RMS)
        .collect();
    if loud.is_empty() {
        return None;
    }
    loud.sort_by(f32::total_cmp);
    let index = ((loud.len() - 1) as f32 * SPEECH_PERCENTILE).round() as usize;
    Some(loud[index])
}

#[cfg(test)]
#[path = "trim_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "trim_pipeline_tests.rs"]
mod pipeline_tests;

#[cfg(all(test, feature = "whisper"))]
#[path = "trim_model_tests.rs"]
mod model_tests;
