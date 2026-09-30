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

struct FrameBody(Vec<u8>);

impl Write for FrameBody {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_FRAME_BYTES - self.0.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "frame size exceeds 128 KiB",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Serialize once, including JSON escaping/UTF-8, before any child is spawned.
/// Stop at the cap rather than materializing an arbitrarily large JSON body.
pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let mut buffer = FrameBody(Vec::new());
    serde_json::to_writer(&mut buffer, value)
        .map_err(|error| format!("serialize frame JSON: {error}"))?;
    let body = buffer.0;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return Err(format!("invalid frame size: {}", body.len()));
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

pub fn write_encoded_frame(
    writer: &mut impl Write,
    frame: &[u8],
) -> Result<(), String> {
    writer
        .write_all(frame)
        .and_then(|()| writer.flush())
        .map_err(|error: io::Error| format!("write frame: {error}"))
}

#[cfg(test)]
pub fn write_frame<T: Serialize>(
    writer: &mut impl Write,
    value: &T,
) -> Result<(), String> {
    write_encoded_frame(writer, &encode_frame(value)?)
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
    fn outgoing_serialization_stops_at_the_cap() {
        use serde::ser::SerializeSeq;
        struct Large<'a>(&'a std::cell::Cell<usize>);
        impl Serialize for Large<'_> {
            fn serialize<S: serde::Serializer>(
                &self,
                serializer: S,
            ) -> Result<S::Ok, S::Error> {
                let mut sequence = serializer.serialize_seq(Some(100))?;
                let chunk = "x".repeat(8192);
                for _ in 0..100 {
                    sequence.serialize_element(&chunk)?;
                    self.0.set(self.0.get() + 1);
                }
                sequence.end()
            }
        }
        let written = std::cell::Cell::new(0);
        assert!(encode_frame(&Large(&written)).is_err());
        assert!(written.get() < 16, "must stop serializing instead of allocating the entire oversize payload");
    }

    #[test]
    fn oversized_frame_is_rejected_before_allocation() {
        let mut bytes = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        let result = read_frame::<WorkerRequest>(&mut bytes.as_slice());
        assert!(result.unwrap_err().contains("invalid frame size"));
    }
}
