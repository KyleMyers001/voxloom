//! Prewarm (BUS-16 3c-2c C2): load the model and run a short warm-up, so
//! the first dictation after launch or switch-on doesn't pay for the cold
//! load and the Metal pipeline compile inside its 10 s budget.
//!
//! The model is loaded once. A dictation that arrives meanwhile is handed
//! to this same process as a second request frame: it waits for the load
//! (never cancelled, never repeated) and takes priority over the warm-up
//! decode, which stops at the next token. Every request frame gets exactly
//! one reply, in order: the prewarm frame's first, then the dictation's.
//! Without a dictation, the app ends the process after the first reply.

use std::io::{self, Read};
use std::process::ExitCode;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Instant;

use crate::engine::{Engine, Generate};
use crate::error::WorkerError;
use crate::protocol::{read_frame, write_encoded_frame, WorkerRequest};
use crate::request::{self, MODEL_PATH};

/// Reply tokens the warm-up decodes before it stops. Provisional: enough to
/// compile the decode pipelines; tuned on Qwen3-1.7B after BUS-114.
pub const WARMUP_TOKENS: usize = 8;

/// The prewarm frame's reply text: the warm-up ran, or a request cut it short.
pub const WARM: &str = "warm";
pub const PREEMPTED: &str = "preempted";

type Frame = (WorkerRequest, Instant);

pub fn serve(prewarm: WorkerRequest) -> ExitCode {
    let frames = listen();
    let mut pending = None;
    let loaded = request::check(&prewarm.model_path, &prewarm.prompt).and_then(|()| load());
    let warmed = match &loaded {
        Ok(engine) => warm_up(engine.as_ref(), &prewarm.prompt, &frames, &mut pending),
        Err(error) => Err(*error),
    };
    let reply = match warmed {
        Ok(text) => request::ok_response(prewarm.request_id, text.into()),
        Err(error) => error.into_response(prewarm.request_id),
    };
    if !write(reply) {
        return ExitCode::from(3);
    }
    // At most one more request, the dictation handed over. Without one the
    // app ends the process (killing it, or closing stdin for listen()).
    let Some((request, arrived)) = pending.or_else(|| frames.recv().ok()) else {
        return ExitCode::SUCCESS;
    };
    let response = match &loaded {
        Ok(engine) => request::handle_loaded(engine.as_ref(), request, arrived),
        Err(error) => error.into_response(request.request_id),
    };
    let ok = response.status == "ok";
    match (write(response), ok) {
        (false, _) => ExitCode::from(3),
        (true, true) => ExitCode::SUCCESS,
        (true, false) => ExitCode::from(2),
    }
}

fn load() -> Result<Box<dyn Generate>, WorkerError> {
    #[cfg(debug_assertions)]
    if let Some(fake) = crate::test_hook::fake_engine() {
        return Ok(Box::new(fake));
    }
    Ok(Box::new(Engine::load(MODEL_PATH)?))
}

/// Decode a few tokens of the prewarm prompt, unless a request frame has
/// arrived (checked before the warm-up and before every token).
fn warm_up(
    engine: &dyn Generate,
    prompt: &str,
    frames: &Receiver<Frame>,
    pending: &mut Option<Frame>,
) -> Result<&'static str, WorkerError> {
    let mut preempt = || {
        if pending.is_none() {
            *pending = frames.try_recv().ok();
        }
        pending.is_some()
    };
    if preempt() {
        return Ok(PREEMPTED);
    }
    match engine.generate(prompt, None, WARMUP_TOKENS, &mut preempt) {
        Err(error) if error == WorkerError::preempted() => Ok(PREEMPTED),
        // The text is discarded: running the decode is the point, so a
        // capped or unusable reply still counts as warm.
        Ok(_) => Ok(WARM),
        Err(error) if error.code == "invalid-output" => Ok(WARM),
        Err(error) => Err(error),
    }
}

/// Read request frames from stdin on a background thread. The first one
/// (the handed-over dictation) is passed on; after that, as in parent.rs,
/// end of stdin or a read error means the app is gone or done with us,
/// and the process ends at once without a reply.
fn listen() -> Receiver<Frame> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut stdin = io::stdin();
        if let Ok(request) = read_frame::<WorkerRequest>(&mut stdin) {
            let _ = sender.send((request, Instant::now()));
            let mut buffer = [0_u8; 64];
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
        }
        // SAFETY: as in parent.rs: _exit touches no Rust or llama.cpp state.
        unsafe { libc::_exit(crate::parent::GONE_EXIT_CODE) }
    });
    receiver
}

fn write(response: crate::protocol::WorkerResponse) -> bool {
    let (frame, _) = crate::reply_frame(response);
    write_encoded_frame(&mut io::stdout().lock(), &frame).is_ok()
}
