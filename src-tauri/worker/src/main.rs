//! Voxloom cleanup worker (BUS-16 PR 3c-1): one framed request on stdin, one
//! framed reply on stdout, then exit. The model arrives on fd 3. Nothing about
//! the request is ever written to stderr.

// The app's own protocol module, compiled into this crate from the same file
// so the frame format and field names cannot drift.
#[path = "../../src/cleanup/protocol.rs"]
mod protocol;

mod engine;
mod error;
mod output;
mod request;
mod template;
mod user_tokens;

use std::io::{self, Write};
use std::process::ExitCode;

use protocol::{encode_frame, read_frame, write_encoded_frame, WorkerRequest, WorkerResponse};

const PANIC_MESSAGE: &[u8] = b"voxloom-cleanup-worker: internal error\n";

fn main() -> ExitCode {
    // The default hook prints the payload, which may quote request data.
    std::panic::set_hook(Box::new(|_| {
        let _ = io::stderr().write_all(PANIC_MESSAGE);
    }));
    let response = match read_frame::<WorkerRequest>(&mut io::stdin().lock()) {
        Ok(request) => request::handle(request),
        // No request ID is known; the supervisor accepts an empty one here.
        Err(_) => error::WorkerError::runtime("invalid request frame").into_response(String::new()),
    };
    let (frame, ok) = reply_frame(response);
    if write_encoded_frame(&mut io::stdout().lock(), &frame).is_err() {
        return ExitCode::from(3);
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    }
}

/// Encode the reply, and whether it is a success. A reply that cannot be
/// framed (over the 128 KiB cap) becomes a fixed invalid-output error for
/// the same request, so the app always gets a frame.
fn reply_frame(response: WorkerResponse) -> (Vec<u8>, bool) {
    let ok = response.status == "ok";
    let request_id = response.request_id.clone();
    match encode_frame(&response) {
        Ok(frame) => (frame, ok),
        Err(_) => {
            let fallback = error::WorkerError::output("cleanup reply could not be framed")
                .into_response(request_id);
            // A fixed message plus an ID taken from a ≤128 KiB request frame.
            (encode_frame(&fallback).unwrap_or_default(), false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(frame: &[u8]) -> WorkerResponse {
        protocol::read_frame(&mut &frame[..]).unwrap()
    }

    #[test]
    fn a_normal_reply_is_framed_as_is() {
        let response = request::ok_response("r1".into(), "Hello.".into());
        let (frame, ok) = reply_frame(response);
        assert!(ok);
        let decoded = decode(&frame);
        assert_eq!(decoded.text.as_deref(), Some("Hello."));
        assert_eq!(decoded.request_id, "r1");
    }

    #[test]
    fn an_unframeable_reply_becomes_a_fixed_invalid_output_error() {
        let huge = "x".repeat(protocol::MAX_FRAME_BYTES);
        let (frame, ok) = reply_frame(request::ok_response("r2".into(), huge));
        assert!(!ok);
        let decoded = decode(&frame);
        assert_eq!(decoded.status, "error");
        assert_eq!(decoded.error_code.as_deref(), Some("invalid-output"));
        assert_eq!(
            decoded.error.as_deref(),
            Some("cleanup reply could not be framed")
        );
        assert_eq!(decoded.request_id, "r2");
        assert!(decoded.text.is_none());
    }
}
