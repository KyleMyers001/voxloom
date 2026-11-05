use crate::stt::{engine::TranscriptDto, error::SttErrorDto};
use serde_json::Value;
pub const MAX_CONTROL: usize = 65_536;
pub const MAX_SAMPLES: usize = 1_920_000;
/// The capture resampler (windowed sinc, unclamped) can overshoot full scale on
/// loud in-range input. Clamp finite samples so the strict worker accepts them;
/// NaN and infinities are left for `validate_pcm` to reject.
pub fn clamp_pcm(samples: &mut [f32]) {
    for sample in samples.iter_mut().filter(|s| s.is_finite()) {
        *sample = sample.clamp(-1.0, 1.0);
    }
}
pub fn validate_pcm(samples: &[f32], rate: u32) -> Result<(), SttErrorDto> {
    if rate != 16_000
        || samples.is_empty()
        || samples.len() > MAX_SAMPLES
        || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0)
    {
        return Err(SttErrorDto::new(
            "unsupported-audio",
            "Expected bounded finite mono 16 kHz PCM",
        ));
    }
    Ok(())
}
pub fn frame(value: &Value) -> Result<Vec<u8>, SttErrorDto> {
    let json = serde_json::to_vec(value)
        .map_err(|_| SttErrorDto::new("transcribe-failed", "Invalid worker control"))?;
    if json.is_empty() || json.len() > MAX_CONTROL {
        return Err(SttErrorDto::new(
            "transcribe-failed",
            "Worker control exceeds limit",
        ));
    }
    let mut bytes = (json.len() as u32).to_le_bytes().to_vec();
    bytes.extend(json);
    Ok(bytes)
}
pub fn identity(value: &Value, id: &str) -> Result<(), SttErrorDto> {
    if value["protocolVersion"] != 1 || value["requestId"].as_str() != Some(id) {
        return Err(invalid());
    }
    Ok(())
}
pub fn invalid() -> SttErrorDto {
    SttErrorDto::new("transcribe-failed", "Invalid Parakeet worker reply")
}
pub fn worker_error(value: &Value) -> SttErrorDto {
    let code = match value["code"].as_str() {
        Some("model-missing") => "model-missing",
        Some("unsupported-audio") => "unsupported-audio",
        Some("engine-unavailable") => "engine-unavailable",
        _ => "transcribe-failed",
    };
    SttErrorDto::new(code, "Parakeet worker failed")
}
pub fn result(value: Value, id: &str, version: &str) -> Result<TranscriptDto, SttErrorDto> {
    identity(&value, id)?;
    if value["op"] == "error" {
        return Err(worker_error(&value));
    }
    if value["op"] != "result" || value.get("dropped") != Some(&Value::Null) {
        return Err(invalid());
    }
    let language = match (version, value.get("language")) {
        ("v2", Some(v)) if v == "en" => Some("en".to_owned()),
        ("v3", Some(Value::Null)) => None,
        _ => return Err(invalid()),
    };
    Ok(TranscriptDto {
        text: value["text"].as_str().ok_or_else(invalid)?.to_owned(),
        raw_text: value["rawText"].as_str().ok_or_else(invalid)?.to_owned(),
        language,
        dropped: None,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pcm_rejects_nonfinite_range_rate_empty_and_overflow() {
        for (samples, rate) in [
            (vec![], 16000),
            (vec![0.1], 8000),
            (vec![f32::NAN], 16000),
            (vec![f32::INFINITY], 16000),
            (vec![1.01], 16000),
            (vec![0.1; MAX_SAMPLES + 1], 16000),
        ] {
            assert_eq!(
                validate_pcm(&samples, rate).unwrap_err().code,
                "unsupported-audio"
            );
        }
        validate_pcm(&[-1.0, 0.0, 1.0], 16000).unwrap();
    }
    #[test]
    fn clamp_pcm_bounds_resampler_overshoot_but_keeps_nonfinite_invalid() {
        let mut samples = vec![1.068, -1.056, 0.5];
        clamp_pcm(&mut samples);
        assert_eq!(samples, vec![1.0, -1.0, 0.5]);
        validate_pcm(&samples, 16000).unwrap();
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut samples = vec![1.068, bad];
            clamp_pcm(&mut samples);
            assert_eq!(
                validate_pcm(&samples, 16000).unwrap_err().code,
                "unsupported-audio"
            );
        }
    }
    #[test]
    fn result_validates_identity_schema_and_language_without_whisper_cleanup() {
        let v = serde_json::json!({"protocolVersion":1,"op":"result","requestId":"r","text":"[Music] Thank you.","rawText":"[Music] Thank you.","language":null,"dropped":null});
        let out = result(v.clone(), "r", "v3").unwrap();
        assert_eq!(out.text, "[Music] Thank you.");
        assert_eq!(out.language, None);
        assert!(result(v.clone(), "other", "v3").is_err());
        assert!(result(v.clone(), "r", "v2").is_err());
        for (key, value) in [
            ("protocolVersion", serde_json::json!(2)),
            ("op", serde_json::json!("ready")),
            ("text", Value::Null),
            ("dropped", serde_json::json!("silent-audio")),
        ] {
            let mut bad = v.clone();
            bad[key] = value;
            assert!(result(bad, "r", "v3").is_err());
        }
        let err=result(serde_json::json!({"protocolVersion":1,"op":"error","requestId":"r","code":"model-missing","message":"private speech and path"}),"r","v3").unwrap_err();
        assert_eq!(err.code, "model-missing");
        assert!(!err.message.contains("private"));
    }
    #[test]
    fn wire_frame_is_bounded_little_endian_json() {
        let value = serde_json::json!({"protocolVersion":1,"op":"ready","requestId":"r"});
        let encoded = frame(&value).unwrap();
        assert_eq!(
            u32::from_le_bytes(encoded[..4].try_into().unwrap()) as usize,
            encoded.len() - 4
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&encoded[4..]).unwrap(),
            value
        );
        assert!(frame(&serde_json::json!({"text":"x".repeat(MAX_CONTROL)})).is_err());
    }
}
