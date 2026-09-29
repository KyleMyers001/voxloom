use std::io::{self, Read, Write};

use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub const MAX_FRAME_BYTES: usize = 128 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRequest {
    pub model_path: String,
    pub prompt: String,
    pub request_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerResponse {
    pub error: Option<String>,
    pub error_code: Option<String>,
    pub request_id: String,
    pub status: String,
    pub text: Option<String>,
}

pub fn read_frame<T: DeserializeOwned>(
    reader: &mut impl Read,
) -> Result<T, String> {
    let mut header = [0_u8; 4];
    reader
        .read_exact(&mut header)
        .map_err(|error| format!("read frame header: {error}"))?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err(format!("invalid frame size: {size}"));
    }
    let mut body = vec![0_u8; size];
    reader
        .read_exact(&mut body)
        .map_err(|error| format!("read frame body: {error}"))?;
    serde_json::from_slice(&body)
        .map_err(|error| format!("parse frame JSON: {error}"))
}

pub fn write_frame<T: Serialize>(
    writer: &mut impl Write,
    value: &T,
) -> Result<(), String> {
    let body = serde_json::to_vec(value)
        .map_err(|error| format!("serialize frame JSON: {error}"))?;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return Err(format!("invalid frame size: {}", body.len()));
    }
    writer
        .write_all(&(body.len() as u32).to_be_bytes())
        .and_then(|()| writer.write_all(&body))
        .and_then(|()| writer.flush())
        .map_err(|error: io::Error| format!("write frame: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip() {
        let request = WorkerRequest {
            model_path: "/private/model.gguf".into(),
            prompt: "hello".into(),
            request_id: "r1".into(),
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &request).unwrap();
        let decoded: WorkerRequest = read_frame(&mut bytes.as_slice()).unwrap();
        assert_eq!(decoded.request_id, "r1");
        assert_eq!(decoded.prompt, "hello");
    }

    #[test]
    fn oversized_frame_is_rejected_before_allocation() {
        let mut bytes = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        let result = read_frame::<WorkerRequest>(&mut bytes.as_slice());
        assert!(result.unwrap_err().contains("invalid frame size"));
    }
}
