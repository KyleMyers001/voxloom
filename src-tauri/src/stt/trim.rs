//! BUS-139: trim the quiet tail of a clip before whisper.
//!
//! Whisper hallucinates "Thank you." or "you" over the silence or room noise
//! left after the last word. The trailing run of quiet 20 ms frames is cut
//! down to a short kept tail. "Quiet" is relative to the clip's own speech
//! level, with an absolute floor, so a mic with a higher noise floor still
//! trims when the speech is much louder.

use super::gate::AudioStats;

const FRAME_MS: usize = 20;
/// Tail kept after the last loud frame, for soft consonants and releases.
const KEPT_TAIL_MS: usize = 250;
/// Frames at or above this RMS (≈ −44 dBFS) may be speech. Hallucinated
/// tails measured 0.0000–0.0011 RMS in the BUS-139 harness.
const ABSOLUTE_FLOOR_RMS: f32 = 0.006;
/// Speech level: this percentile of the possible-speech frames.
const SPEECH_PERCENTILE: f32 = 0.9;
/// Quiet is below this fraction (−20 dB) of the speech level. Harness
/// speech measured ≥ 0.06 RMS, so its threshold sits well above any tail.
const RELATIVE_FACTOR: f32 = 0.1;

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
    // The speech-level frame is >= threshold, so this never covers the clip.
    let quiet_frames = levels.iter().rev().take_while(|&&r| r < threshold).count();
    let quiet_start = (levels.len() - quiet_frames) * frame;
    let tail_rms = if quiet_frames == 0 {
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

#[cfg(all(test, feature = "whisper"))]
#[path = "trim_model_tests.rs"]
mod model_tests;
