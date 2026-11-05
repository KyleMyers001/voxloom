//! Sole child ownership; bounded nonblocking pipes, never a registry lock during IPC.
use super::protocol;
use crate::stt::{engine::TranscriptDto, error::SttErrorDto};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
pub struct Worker {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
}
fn io_error(_: std::io::Error) -> SttErrorDto {
    SttErrorDto::new("transcribe-failed", "Parakeet worker pipe failed")
}
pub fn check(cancel: &AtomicBool, deadline: Instant) -> Result<(), SttErrorDto> {
    if cancel.load(Ordering::SeqCst) {
        return Err(SttErrorDto::new("cancelled", "Parakeet request cancelled"));
    }
    if Instant::now() >= deadline {
        return Err(SttErrorDto::new(
            "timeout",
            "Parakeet worker deadline exceeded",
        ));
    }
    Ok(())
}
#[cfg(unix)]
fn nonblocking(fd: std::os::fd::RawFd) -> Result<(), SttErrorDto> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}
impl Worker {
    pub fn load(
        path: &Path,
        dir: &Path,
        id: &str,
        version: &str,
        cancel: &AtomicBool,
        timeout: Duration,
    ) -> Result<Self, SttErrorDto> {
        let deadline = Instant::now() + timeout;
        check(cancel, deadline)?;
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| {
                SttErrorDto::new("engine-unavailable", "Parakeet worker is unavailable")
            })?;
        let input = child.stdin.take().expect("piped stdin");
        let output = child.stdout.take().expect("piped stdout");
        let mut worker = Self {
            child,
            input,
            output,
        };
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            nonblocking(worker.input.as_raw_fd())?;
            nonblocking(worker.output.as_raw_fd())?;
        }
        #[cfg(not(unix))]
        {
            return Err(SttErrorDto::new(
                "engine-unavailable",
                "Parakeet requires macOS",
            ));
        }
        worker.write(&protocol::frame(&serde_json::json!({"protocolVersion":1,"op":"load","requestId":id,"modelVersion":version,"modelDirectory":dir}))?,cancel,deadline)?;
        let ready = worker.read_json(cancel, deadline)?;
        protocol::identity(&ready, id)?;
        if ready["op"] == "error" {
            return Err(protocol::worker_error(&ready));
        }
        if ready["op"] != "ready" {
            return Err(protocol::invalid());
        }
        Ok(worker)
    }
    fn write(
        &mut self,
        mut bytes: &[u8],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), SttErrorDto> {
        while !bytes.is_empty() {
            check(cancel, deadline)?;
            match self.input.write(bytes) {
                Ok(0) => return Err(protocol::invalid()),
                Ok(n) => bytes = &bytes[n..],
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(io_error(e)),
            }
        }
        Ok(())
    }
    fn read_exact(
        &mut self,
        mut bytes: &mut [u8],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), SttErrorDto> {
        while !bytes.is_empty() {
            check(cancel, deadline)?;
            match self.output.read(bytes) {
                Ok(0) => return Err(protocol::invalid()),
                Ok(n) => bytes = &mut bytes[n..],
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(io_error(e)),
            }
        }
        Ok(())
    }
    fn read_json(
        &mut self,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<serde_json::Value, SttErrorDto> {
        let mut prefix = [0; 4];
        self.read_exact(&mut prefix, cancel, deadline)?;
        let n = u32::from_le_bytes(prefix) as usize;
        if n == 0 || n > protocol::MAX_CONTROL {
            return Err(protocol::invalid());
        }
        let mut payload = vec![0; n];
        self.read_exact(&mut payload, cancel, deadline)?;
        serde_json::from_slice(&payload).map_err(|_| protocol::invalid())
    }
    pub fn transcribe(
        &mut self,
        id: &str,
        version: &str,
        pcm: &[f32],
        cancel: &AtomicBool,
        timeout: Duration,
    ) -> Result<TranscriptDto, SttErrorDto> {
        protocol::validate_pcm(pcm, 16000)?;
        let deadline = Instant::now() + timeout;
        self.write(&protocol::frame(&serde_json::json!({"protocolVersion":1,"op":"transcribe","requestId":id,"sampleRateHz":16000,"sampleCount":pcm.len()}))?,cancel,deadline)?;
        // Bounded chunks avoid another full-size audio allocation. Never write audio to disk.
        for chunk in pcm.chunks(4096) {
            let bytes: Vec<u8> = chunk.iter().flat_map(|s| s.to_le_bytes()).collect();
            self.write(&bytes, cancel, deadline)?;
        }
        let value = self.read_json(cancel, deadline)?;
        let out = protocol::result(value, id, version)?;
        let exit_deadline = std::cmp::min(deadline, Instant::now() + Duration::from_secs(2));
        loop {
            check(cancel, exit_deadline)?;
            if let Some(status) = self.child.try_wait().map_err(io_error)? {
                if !status.success() {
                    return Err(protocol::invalid());
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(out)
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[cfg(all(test, unix))]
#[path = "process_tests.rs"]
pub(super) mod tests;
