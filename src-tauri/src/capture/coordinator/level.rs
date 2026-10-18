use super::*;

/// Emit bounded, content-free microphone energy to drive the overlay.
pub(super) struct LevelMeter {
    last_emit: Duration,
    power_sum: f64,
    sample_count: usize,
}

impl LevelMeter {
    pub(super) fn new(start: Duration) -> Self {
        Self {
            last_emit: start,
            power_sum: 0.0,
            sample_count: 0,
        }
    }

    pub(super) fn observe(&mut self, samples: &[f32]) {
        for &sample in samples {
            if sample.is_finite() {
                self.power_sum += f64::from(sample) * f64::from(sample);
                self.sample_count += 1;
            }
        }
    }

    pub(super) fn take_if_due(&mut self, now: Duration) -> Option<f32> {
        if now.saturating_sub(self.last_emit) < LEVEL_INTERVAL {
            return None;
        }
        let level = if self.sample_count == 0 {
            0.0
        } else {
            (self.power_sum / self.sample_count as f64).sqrt().min(1.0) as f32
        };
        self.last_emit = now;
        self.power_sum = 0.0;
        self.sample_count = 0;
        Some(level)
    }
}
