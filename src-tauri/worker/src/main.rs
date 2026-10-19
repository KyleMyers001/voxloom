//! Voxloom cleanup worker (BUS-16 PR 3c-1): one framed request on stdin, one
//! framed reply on stdout, then exit. The model arrives on fd 3. Nothing about
//! the request is ever written to stderr.

// The app's own protocol module, compiled into this crate from the same file
// so the frame format and field names cannot drift.
#[path = "../../src/cleanup/protocol.rs"]
mod protocol;

mod engine;
mod error;
mod request;
mod template;

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
    let ok = response.status == "ok";
    if write_response(&response).is_err() {
        return ExitCode::from(3);
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    }
}

fn write_response(response: &WorkerResponse) -> Result<(), String> {
    let frame = encode_frame(response)?;
    write_encoded_frame(&mut io::stdout().lock(), &frame)
}
