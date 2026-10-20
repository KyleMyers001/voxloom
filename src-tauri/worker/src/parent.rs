//! Exit when the app is gone (BUS-16 3c-2, QA M1). Without this a worker
//! whose app crashed or was force-quit kept generating until its token
//! budget ran out: minutes of CPU and gigabytes of memory for a reply
//! nobody reads.
//!
//! The app keeps the worker's stdin open until it has the reply. However the
//! app ends, crash and SIGKILL included, the kernel closes that pipe, so end
//! of stdin after the request means the app is gone or has given up. This
//! works the same on macOS and Linux, needs no polling, and does not depend
//! on which app thread spawned the worker (unlike Linux PR_SET_PDEATHSIG).

use std::io::{self, Read};
use std::thread;

/// Exit status when stdin closed before `main` returned. Usually the app
/// went away mid-request and no reply was written. It can also follow a
/// complete, successful reply: the app closes stdin once it has read the
/// reply, which may be before `main` gets to return 0. The app ignores the
/// worker's exit status, so this is harmless; read the reply, not the code.
pub const GONE_EXIT_CODE: i32 = 4;

/// Watch stdin on a background thread, once the request frame has been
/// read, and end the process at EOF or a read error. Bytes after the frame
/// are ignored.
pub fn exit_when_stdin_closes() {
    thread::spawn(|| {
        let mut buffer = [0_u8; 64];
        loop {
            match io::stdin().read(&mut buffer) {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        // _exit, not process::exit: generation is still running on the
        // main thread, and exit handlers (llama.cpp/ggml static destructors,
        // the Metal device) must not tear its state down under it. The
        // kernel reclaims the memory, the model mapping and fd 3.
        // SAFETY: _exit ends the process at once and touches no Rust state.
        unsafe { libc::_exit(GONE_EXIT_CODE) }
    });
}
