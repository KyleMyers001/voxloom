//! BUS-139: the quiet level that ends speech in the tail: the tail's noise
//! floor plus a margin, measured before a noise gate when there is one.

use super::percentile;

/// Tail noise floor: this percentile of the frames after the loud anchor.
/// Low, so a soft final word longer than the noise doesn't set it.
const NOISE_PERCENTILE: f32 = 0.2;
/// Quiet level: the noise floor times this (+6 dB).
const NOISE_MARGIN: f32 = 2.0;
/// Lowest quiet level (≈ −74 dBFS), for a digitally silent tail. A final
/// word 32 dB under −30 dBFS speech sits near −62 dBFS.
pub(super) const MIN_QUIET_RMS: f32 = 0.0002;
/// A clip whose last 200 ms sit at or under this RMS (≈ −74 dBFS) may end
/// in a noise gate: digital silence, dither, or room noise lowered 20 dB.
const GATED_MAX_RMS: f32 = 0.0002;
/// The gated stretch: frames up to this many times the level of the last
/// 200 ms (+6 dB), or one 16-bit LSB, whichever is higher.
const GATED_MARGIN: f32 = 2.0;
const LSB_RMS: f32 = 1.0 / 32_768.0;
/// Window for the noise floor before a gate (200 ms).
const NOISE_FRAMES: usize = 10;
/// Quiet level before a gate: the floor times this (+8 dB). The quietest
/// window reads lower than the whole tail, so a breath or noise swell just
/// before the gate needs more margin not to count as speech.
const GATED_NOISE_MARGIN: f32 = 2.5;
/// Before a gate the quiet level stays this far under the loud threshold
/// (−6 dB), so soft speech running into the gate still counts.
const GATED_QUIET_FACTOR: f32 = 0.5;

/// 6 dB over the noise floor of the frames after the loud anchor, at most
/// `threshold`. If the tail ends in a gate after 200 ms or more of sound,
/// the quietest 200 ms before the gate set the floor (+8 dB), and the level
/// stays 6 dB under `threshold`.
pub(super) fn quiet_level(tail: &[f32], threshold: f32) -> f32 {
    let quiet = |noise: f32, margin: f32| (noise * margin).max(MIN_QUIET_RMS);
    match gate_start(tail) {
        Some(n) if n >= NOISE_FRAMES => {
            let noise = tail[..n]
                .windows(NOISE_FRAMES)
                .filter_map(|w| percentile(w.to_vec(), NOISE_PERCENTILE))
                .fold(f32::INFINITY, f32::min);
            quiet(noise, GATED_NOISE_MARGIN).min(threshold * GATED_QUIET_FACTOR)
        }
        _ => {
            let noise = percentile(tail.to_vec(), NOISE_PERCENTILE).unwrap_or(0.0);
            quiet(noise, NOISE_MARGIN).min(threshold)
        }
    }
}

/// Start of the gated stretch at the end of `tail`: the last 200 ms are at
/// or under `GATED_MAX_RMS`, and the stretch runs back while frames stay
/// within `GATED_MARGIN` of that level. `None` when the tail isn't gated.
fn gate_start(tail: &[f32]) -> Option<usize> {
    let last = &tail[tail.len().saturating_sub(NOISE_FRAMES)..];
    let level = last.iter().copied().fold(0.0, f32::max);
    if level > GATED_MAX_RMS {
        return None;
    }
    let limit = (level * GATED_MARGIN).max(LSB_RMS);
    Some(tail.iter().rposition(|&r| r > limit).map_or(0, |i| i + 1))
}
