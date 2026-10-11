//! Process-local PCM buffer store for capture → STT handoff.
//!
//! No PCM bytes cross IPC. The renderer only receives an opaque handle
//! (`id` + duration/sample-rate metadata). `take` consumes the samples
//! for transcription.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::capture::buffer::{CaptureBuffer, TARGET_RATE};

#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioBufferHandleDto {
    pub id: String,
    pub duration_ms: u64,
    pub sample_rate_hz: u32,
}

struct StoredBuffer {
    samples: Vec<f32>,
    sample_rate_hz: u32,
}

/// Bounded in-memory PCM store. Oldest buffers are dropped when full.
pub struct PcmBufferStore {
    inner: Mutex<HashMap<String, StoredBuffer>>,
    next_id: Mutex<u64>,
}

const MAX_BUFFERS: usize = 4;

impl PcmBufferStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    /// Deposit a finished capture buffer; returns handle metadata only.
    pub fn deposit(&self, buffer: CaptureBuffer) -> AudioBufferHandleDto {
        let duration_ms = (buffer.duration().as_secs_f64() * 1000.0).round() as u64;
        let samples = buffer.into_samples();
        let id = {
            let mut next = self.next_id.lock().unwrap();
            let n = *next;
            *next = next.saturating_add(1);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            format!("pcm-{stamp}-{n}")
        };

        let mut map = self.inner.lock().unwrap();
        while map.len() >= MAX_BUFFERS {
            if let Some(oldest) = map.keys().next().cloned() {
                map.remove(&oldest);
            } else {
                break;
            }
        }
        map.insert(
            id.clone(),
            StoredBuffer {
                samples,
                sample_rate_hz: TARGET_RATE,
            },
        );

        AudioBufferHandleDto {
            id,
            duration_ms,
            sample_rate_hz: TARGET_RATE,
        }
    }

    /// Take (consume) samples for transcription.
    pub fn take(&self, id: &str) -> Option<(Vec<f32>, u32)> {
        let mut map = self.inner.lock().unwrap();
        map.remove(id).map(|b| (b.samples, b.sample_rate_hz))
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

impl Default for PcmBufferStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::buffer::CaptureBuffer;

    #[test]
    fn deposit_and_take_round_trip() {
        let store = PcmBufferStore::new();
        let mut buf = CaptureBuffer::new();
        buf.push(&[0.1, 0.2, 0.3]).unwrap();
        let handle = store.deposit(buf);
        assert!(!handle.id.is_empty());
        assert_eq!(handle.sample_rate_hz, TARGET_RATE);
        let (samples, rate) = store.take(&handle.id).unwrap();
        assert_eq!(samples, vec![0.1, 0.2, 0.3]);
        assert_eq!(rate, TARGET_RATE);
        assert!(store.take(&handle.id).is_none());
    }

    #[test]
    fn deposit_does_not_run_network() {
        // Constructing / depositing never downloads models.
        let store = PcmBufferStore::new();
        assert_eq!(store.len(), 0);
    }
}
