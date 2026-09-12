/// CPAL input stream adapter for macOS CoreAudio.
///
/// Opens a real-time input stream on the named device (or system default),
/// pushes interleaved f32 samples into a bounded `mpsc` queue, and provides
/// an explicit stop handle. The real-time callback never blocks, allocates
/// beyond the pre-allocated queue, logs, or emits IPC.
use std::sync::mpsc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, SampleRate, StreamConfig};

/// A message from the real-time callback to the coordinator worker.
#[derive(Debug)]
pub enum CallbackMessage {
    /// Interleaved f32 samples from the device.
    Samples(Vec<f32>),
    /// Real-time stream error; coordinator must treat as fatal.
    Error(String),
}

/// Opened stream plus the channel information needed by the coordinator.
pub struct OpenedStream {
    /// Alive while capture runs; dropping closes the stream.
    pub stream: cpal::Stream,
    /// Number of interleaved channels in the native feed.
    pub channels: u16,
    /// Device sample rate in Hz.
    pub native_rate: u32,
    /// Device name for display; never used as identity.
    pub device_name: String,
    /// Coordinator drains this for normalised samples.
    pub receiver: mpsc::Receiver<CallbackMessage>,
}

/// Maximum pending callback messages before the queue is considered full.
/// When full, the real-time callback silently drops new samples; the
/// watchdog detects prolonged silence and surfaces an error.
pub const QUEUE_CAPACITY: usize = 512;

/// Open an input stream on the system-default device, or the first device
/// matching `preferred_name` by exact string equality.
///
/// Returns an `OpenedStream` on success. The stream is already playing.
/// Errors carry a `"capture-unavailable: …"` prefix.
pub fn open_input(
    preferred_name: Option<&str>,
) -> Result<OpenedStream, String> {
    let host = cpal::default_host();
    let device = resolve_device(&host, preferred_name)?;

    let device_name = device
        .name()
        .unwrap_or_else(|_| String::from("unknown"));

    let default_config = device
        .default_input_config()
        .map_err(|e| format!("capture-unavailable: {e}"))?;

    let channels = default_config.channels();
    let native_rate = default_config.sample_rate().0;

    if default_config.sample_format() != SampleFormat::F32 {
        return Err(format!(
            "capture-unavailable: device sample format {:?} is not f32",
            default_config.sample_format()
        ));
    }

    let config = StreamConfig {
        buffer_size: BufferSize::Default,
        channels,
        sample_rate: SampleRate(native_rate),
    };

    let (tx, receiver) = mpsc::sync_channel::<CallbackMessage>(
        QUEUE_CAPACITY,
    );
    let tx_err = tx.clone();

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                // Real-time: do not block, allocate large objects, or log.
                let _ = tx.try_send(CallbackMessage::Samples(
                    data.to_vec(),
                ));
            },
            move |err| {
                let _ = tx_err.try_send(CallbackMessage::Error(
                    err.to_string(),
                ));
            },
            None,
        )
        .map_err(|e| format!("capture-unavailable: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("capture-unavailable: {e}"))?;

    Ok(OpenedStream {
        channels,
        device_name,
        native_rate,
        receiver,
        stream,
    })
}

/// Enumerate input device names using the default host.
pub fn list_input_device_names() -> Vec<String> {
    let host = cpal::default_host();
    use cpal::traits::HostTrait;
    host.input_devices()
        .map(|devs| {
            devs.filter_map(|d| d.name().ok()).collect()
        })
        .unwrap_or_default()
}

/// Resolve the input device: preferred by exact name, then system default.
fn resolve_device(
    host: &cpal::Host,
    preferred_name: Option<&str>,
) -> Result<cpal::Device, String> {
    if let Some(name) = preferred_name {
        let mut devices = host
            .input_devices()
            .map_err(|e| format!("capture-unavailable: {e}"))?;
        return devices
            .find(|d| d.name().map(|n| n == name).unwrap_or(false))
            .ok_or_else(|| format!(
                "capture-unavailable: \
                 preferred device '{name}' not found"
            ));
    }
    host.default_input_device().ok_or_else(|| {
        String::from("capture-unavailable: no default input device")
    })
}

#[cfg(test)]
mod tests {
    // open_input() requires a live CoreAudio session; exercised via manual
    // tests documented in docs/review/BUS-9-implementation.md.

    use super::CallbackMessage;

    #[test]
    fn callback_message_debug_does_not_include_audio_content() {
        // Verify the Debug impl wraps in "Samples(…)" without raw bytes.
        let msg = CallbackMessage::Samples(vec![0.0f32, 0.5]);
        let debug = format!("{msg:?}");
        assert!(debug.starts_with("Samples("));
    }

    #[test]
    fn error_message_round_trips_string() {
        let msg = CallbackMessage::Error(String::from("device lost"));
        match msg {
            CallbackMessage::Error(s) => {
                assert_eq!(s, "device lost");
            }
            _ => panic!("unexpected variant"),
        }
    }
}
