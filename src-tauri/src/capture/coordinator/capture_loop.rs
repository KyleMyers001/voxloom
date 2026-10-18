use super::*;

// Capture loop

const ACTIVITY_THRESHOLD: f32 = 0.001; // −60 dBFS

pub(super) enum LoopTerminal {
    Clean,
    Cancelled,
    Error(String, String),
}

/// Drain ring buffer, resample, accumulate, detect activity.
/// Both `overflow` and `stream_error` are checked each iteration with
/// distinct error categories.
#[allow(clippy::too_many_arguments)]
pub(super) fn capture_loop<E: Fn(SessionEvent)>(
    consumer: &mut ringbuf::HeapCons<f32>,
    accepting: &CaptureGate,
    callbacks_in_flight: &AtomicUsize,
    overflow: &AtomicBool,
    stream_error: &AtomicBool,
    cancel: &AtomicBool,
    stop: &AtomicBool,
    downmixer: &mut Downmixer,
    buffer: &mut CaptureBuffer,
    bound: Duration,
    limits: CaptureLimits,
    last_sample: &mut Duration,
    activity_emitted: &mut bool,
    start: Duration,
    gen: u64,
    request_id: &str,
    emit: &E,
    runtime: &dyn LoopRuntime,
) -> LoopTerminal {
    let mut drain_buf = vec![0.0f32; RING_CAPACITY];
    let mut meter = LevelMeter::new(start);

    loop {
        if is_cancelled(cancel) {
            return LoopTerminal::Cancelled;
        }

        let now = runtime.now();
        let stop_requested = is_stopped(stop);
        let deadline_reached = now.saturating_sub(start) >= bound;
        // User stop and the 120 s / capacity bound share the clean drain path:
        // close accepting, wait for in-flight callbacks, drain, flush, Clean.
        let ending = deadline_reached || stop_requested;
        if ending {
            // Paired with the callback's SeqCst lease protocol. A callback
            // that observed `accepting = true` is globally ordered before
            // this store, so this load sees its lease unless its write and
            // lease release have already completed.
            accepting.close();
            if callbacks_in_flight.load(Ordering::SeqCst) > 0 {
                runtime.wait(limits.poll_interval);
                continue;
            }
        }
        let n = consumer.pop_slice(&mut drain_buf);

        if n > 0 {
            *last_sample = now;
            let mono = match downmixer.process(&drain_buf[..n]) {
                Ok(m) => m,
                Err(e) => {
                    return LoopTerminal::Error(String::from("capture-unavailable"), e);
                }
            };

            if !*activity_emitted && mono.iter().any(|&s| s.abs() >= ACTIVITY_THRESHOLD) {
                *activity_emitted = true;
                emit(SessionEvent::ActivityDetected {
                    generation: gen,
                    request_id: request_id.to_owned(),
                });
            }

            meter.observe(&mono);

            // Capacity / 120 s sample bound: keep captured PCM and treat as
            // a successful end-of-utterance (deposit via Clean), not an error.
            if buffer.push(&mono).is_err() {
                return LoopTerminal::Clean;
            }
        }

        // Silence emits zero; the rate limit also bounds renderer work.
        if !ending {
            if let Some(level) = meter.take_if_due(now) {
                emit(SessionEvent::CaptureLevel {
                    generation: gen,
                    request_id: request_id.to_owned(),
                    level,
                });
            }
        }

        // Distinct error categories for distinct failure modes.
        if accepting.is_invalidated() {
            return LoopTerminal::Error(
                String::from("capture-unavailable"),
                String::from("Microphone identity changed."),
            );
        }

        if overflow.load(Ordering::Acquire) {
            return LoopTerminal::Error(
                String::from("input-limit-exceeded"),
                String::from("Audio ring buffer overflow."),
            );
        }

        if stream_error.load(Ordering::Acquire) {
            return LoopTerminal::Error(
                String::from("capture-unavailable"),
                String::from("Audio device error (disconnect or revocation)."),
            );
        }

        // Once ending (deadline or user stop), continue until the bounded
        // queue is observed empty, then flush the resampler exactly once.
        if ending && n == 0 {
            match downmixer.flush() {
                Ok(tail) if !tail.is_empty() => {
                    // Flush that would exceed capacity: keep existing PCM.
                    let _ = buffer.push(&tail);
                }
                Ok(_) => {}
                Err(e) => {
                    return LoopTerminal::Error(String::from("capture-unavailable"), e);
                }
            }
            return LoopTerminal::Clean;
        }

        if !ending
            && now.saturating_sub(start) > limits.watchdog_grace
            && now.saturating_sub(*last_sample) > limits.watchdog_idle
        {
            return LoopTerminal::Error(
                String::from("capture-unavailable"),
                String::from("No audio received from device."),
            );
        }

        if !ending {
            runtime.wait(limits.poll_interval);
        }
    }
}
