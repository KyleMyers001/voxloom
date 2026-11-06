use super::*;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
pub(crate) fn fixture(body: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "parakeet-runtime-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&root).unwrap();
    let script = root.join("worker");
    fs::write(&script,format!("#!/usr/bin/python3\nimport os,sys,struct,json,time\ndef readn(n):\n b=b''\n while len(b)<n:\n  c=sys.stdin.buffer.read(n-len(b))\n  if not c: sys.exit(3)\n  b+=c\n return b\ndef read(): return json.loads(readn(struct.unpack('<I',readn(4))[0]))\ndef send(v):\n b=json.dumps(v).encode();sys.stdout.buffer.write(struct.pack('<I',len(b))+b);sys.stdout.buffer.flush()\n{body}\n")).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    script
}
pub(crate) const NORMAL:&str="load=read()\nassert load['op']=='load' and load['protocolVersion']==1\nr=load['requestId']\nsend(dict(protocolVersion=1,op='ready',requestId=r))\nh=read()\nassert h['op']=='transcribe' and h['sampleRateHz']==16000 and h['requestId']==r\na=readn(h['sampleCount']*4)\nassert struct.unpack('<f',a[:4])[0]==0.25\nsend(dict(protocolVersion=1,op='result',requestId=r,text='[Music] Thank you.',rawText='[Music] Thank you.',language=None if load['modelVersion']=='v3' else 'en',dropped=None))";
// Interpreter startup is setup, not cancellation/pipe-deadline latency. The
// deliberate delay exceeds both old startup assumptions (150 ms and 2 s).
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_millis(150);
const SETTLE_TIMEOUT: Duration = Duration::from_secs(2);

fn delayed_fixture(body: &str) -> PathBuf {
    fixture(&format!(
        "time.sleep(2.2)\ndef mark(phase):\n with open(__file__+'.'+phase,'w') as f: f.write(str(os.getpid()))\nmark('pid')\n{body}"
    ))
}

fn wait_until(mut ready: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if ready() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn assert_pid_reaped(pid: i32) {
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "child {pid} survived");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

fn assert_reaped(path: &Path) {
    let pid = fs::read_to_string(path.with_extension("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    assert_pid_reaped(pid);
}

// Exercise the same nonblocking load exchange after a bounded startup handshake.
// Worker::load's public timeout includes spawn/startup; its overall deadline is
// covered separately below, without requiring Python to start within 150 ms.
fn started_worker(path: &Path) -> Worker {
    use std::os::fd::AsRawFd;
    let mut child = Command::new(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let worker = Worker {
        child,
        input,
        output,
    };
    nonblocking(worker.input.as_raw_fd()).unwrap();
    nonblocking(worker.output.as_raw_fd()).unwrap();
    assert!(wait_until(
        || path.with_extension("pid").exists(),
        SETUP_TIMEOUT
    ));
    worker
}

#[test]
fn stalled_load_is_killed_and_reaped_on_deadline() {
    let path = delayed_fixture("load=read();mark('loading');time.sleep(60)");
    let cancel = AtomicBool::new(false);
    let mut worker = started_worker(&path);
    let start = Instant::now();
    let deadline = start + IO_TIMEOUT;
    let frame = protocol::frame(&serde_json::json!({
        "protocolVersion": 1, "op": "load", "requestId": "r",
        "modelVersion": "v3", "modelDirectory": "/model"
    }))
    .unwrap();
    worker.write(&frame, &cancel, deadline).unwrap();
    let result = worker.read_json(&cancel, deadline);
    drop(worker);
    assert_eq!(result.unwrap_err().code, "timeout");
    assert!(start.elapsed() >= IO_TIMEOUT);
    assert!(start.elapsed() < SETTLE_TIMEOUT);
    assert_reaped(&path);
}

#[test]
fn load_api_deadline_includes_startup_and_reaps_the_exact_child() {
    let path = delayed_fixture("load=read();mark('loading');time.sleep(60)");
    let start = Instant::now();
    let result = Worker::load(
        &path,
        Path::new("/model"),
        "r",
        "v3",
        &AtomicBool::new(false),
        SETUP_TIMEOUT,
    );
    assert_eq!(result.err().unwrap().code, "timeout");
    assert!(path.with_extension("loading").exists());
    assert!(start.elapsed() >= SETUP_TIMEOUT);
    assert!(start.elapsed() < SETUP_TIMEOUT + SETTLE_TIMEOUT);
    assert_reaped(&path);
}

#[test]
fn malformed_eof_oversized_and_wrong_identity_are_rejected() {
    for body in [
        "sys.stdout.buffer.write(struct.pack('<I',65537));sys.stdout.buffer.flush()",
        "sys.stdout.buffer.write(struct.pack('<I',8)+b'{}');sys.stdout.buffer.flush()",
        "v=read();send(dict(protocolVersion=1,op='ready',requestId='wrong'))",
    ] {
        let path = fixture(body);
        // A timeout must not accidentally satisfy a protocol-rejection test.
        assert_eq!(
            Worker::load(
                &path,
                Path::new("/model"),
                "r",
                "v3",
                &AtomicBool::new(false),
                SETUP_TIMEOUT
            )
            .err()
            .unwrap()
            .code,
            "transcribe-failed"
        );
    }
}

fn cancel_at_phase(
    path: &Path,
    ready: impl Fn() -> bool,
    operation: impl FnOnce(&AtomicBool) -> Result<(), SttErrorDto> + Send,
) {
    let cancel = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let task = scope.spawn(|| operation(&cancel));
        // Do not panic before cancelling/joining: even failed setup must settle
        // the sole Worker owner, whose Drop kills and waits for its exact child.
        let ready = wait_until(ready, SETUP_TIMEOUT);
        let start = Instant::now();
        cancel.store(true, Ordering::SeqCst);
        let result = task.join();
        let elapsed = start.elapsed();
        eprintln!("fixture cancellation settlement: {elapsed:?}");
        assert!(ready, "fixture did not reach the requested I/O phase");
        assert_eq!(result.unwrap().unwrap_err().code, "cancelled");
        assert!(elapsed < SETTLE_TIMEOUT, "cancellation took {elapsed:?}");
        assert_reaped(path);
    });
}

#[test]
fn cancellation_interrupts_load_without_waiting_for_worker() {
    let path = delayed_fixture("load=read();mark('loading');time.sleep(60)");
    cancel_at_phase(
        &path,
        || path.with_extension("loading").exists(),
        |cancel| {
            Worker::load(&path, Path::new("/model"), "r", "v3", cancel, SETUP_TIMEOUT).map(drop)
        },
    );
}

// Both fixtures consume the transcribe header. Only the inference fixture drains
// PCM: the other leaves binary data filling the pipe, never a blocked header.
fn transcription_fixture(inference: bool) -> PathBuf {
    delayed_fixture(&format!(
        "load=read();r=load['requestId']\nsend(dict(protocolVersion=1,op='ready',requestId=r))\nh=read();mark('header')\n{}\ntime.sleep(60)",
        if inference { "readn(h['sampleCount']*4);mark('inference')" } else { "" }
    ))
}

fn load_fixture(path: &Path, cancel: &AtomicBool) -> Worker {
    Worker::load(path, Path::new("/model"), "r", "v3", cancel, SETUP_TIMEOUT).unwrap()
}

#[test]
fn write_and_inference_reads_have_deadlines_and_reap_the_exact_child() {
    for inference in [false, true] {
        let path = transcription_fixture(inference);
        let cancel = AtomicBool::new(false);
        let mut worker = load_fixture(&path, &cancel);
        // Keep allocation/setup out of the measured operation.
        let pcm = vec![
            0.25;
            if inference {
                16000
            } else {
                protocol::MAX_SAMPLES
            }
        ];
        let start = Instant::now();
        let result = worker.transcribe("r", "v3", &pcm, &cancel, IO_TIMEOUT);
        drop(worker);
        assert_eq!(result.unwrap_err().code, "timeout");
        assert!(start.elapsed() >= IO_TIMEOUT);
        assert!(start.elapsed() < SETTLE_TIMEOUT);
        assert!(path
            .with_extension(if inference { "inference" } else { "header" })
            .exists());
        assert_reaped(&path);
    }
}

#[test]
fn cancellation_interrupts_inference_and_blocked_binary_write() {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    for inference in [false, true] {
        let path = transcription_fixture(inference);
        let mut worker = load_fixture(&path, &AtomicBool::new(false));
        let pcm = vec![
            0.25;
            if inference {
                16000
            } else {
                protocol::MAX_SAMPLES
            }
        ];
        // An owned duplicate lets the observer check actual pipe backpressure,
        // without racing fd reuse if the operation unexpectedly returns early.
        let fd = unsafe { libc::fcntl(worker.input.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        assert!(fd >= 0);
        let input = unsafe { OwnedFd::from_raw_fd(fd) };
        cancel_at_phase(
            &path,
            || {
                if inference {
                    return path.with_extension("inference").exists();
                }
                let mut poll = libc::pollfd {
                    fd: input.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                };
                path.with_extension("header").exists()
                    && unsafe { libc::poll(&mut poll, 1, 0) } == 0
            },
            move |cancel| {
                worker
                    .transcribe("r", "v3", &pcm, cancel, SETUP_TIMEOUT)
                    .map(|_| ())
            },
        );
    }
}

#[test]
fn worker_is_killed_and_reaped_when_a_test_assertion_unwinds() {
    let path = fixture("load=read();send(dict(protocolVersion=1,op='ready',requestId=load['requestId']));time.sleep(60)");
    let worker = load_fixture(&path, &AtomicBool::new(false));
    let pid = worker.child.id() as i32;
    let panic = std::panic::catch_unwind(move || {
        let _worker = worker;
        panic!("intentional fixture assertion failure");
    });
    assert!(panic.is_err());
    assert_pid_reaped(pid);
}
#[test]
#[ignore = "requires explicitly approved local Parakeet assets and the production Swift helper"]
fn rust_swift_real_coreml_join_with_local_models() {
    let binary = std::env::var_os("VOXLOOM_PARAKEET_WORKER")
        .expect("set the exact production Swift helper executable");
    let models = PathBuf::from(
        std::env::var_os("VOXLOOM_PARAKEET_MODELS")
            .expect("set the explicitly provisioned model-set parent directory"),
    );
    let raw = include_bytes!("../fixtures/trim_corpus/libri_128104-0008_a0.s16");
    let pcm: Vec<f32> = raw
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0)
        .collect();
    for version in ["v2", "v3"] {
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let mut worker = Worker::load(
            Path::new(&binary),
            &models.join(format!("parakeet-tdt-0.6b-{version}-coreml")),
            "rust-real-coreml",
            version,
            &cancel,
            Duration::from_secs(90),
        )
        .expect("real local Core ML loading must succeed");
        let ready = started.elapsed();
        let result = worker
            .transcribe(
                "rust-real-coreml",
                version,
                &pcm,
                &cancel,
                Duration::from_secs(120),
            )
            .expect("real Rust/Swift transcription and child settlement must succeed");
        assert!(!result.text.trim().is_empty());
        assert_eq!(result.raw_text, result.text);
        assert_eq!(
            result.language.as_deref(),
            (version == "v2").then_some("en")
        );
        assert!(result.dropped.is_none());
        eprintln!(
            "real-coreml {version}: ready_ms={} total_ms={} samples={}",
            ready.as_millis(),
            started.elapsed().as_millis(),
            pcm.len()
        );
    }
}

#[test]
#[ignore = "requires the explicitly built model-free Swift fixture path"]
fn rust_swift_framed_protocol_join_without_models() {
    let fixture = std::env::var_os("VOXLOOM_PARAKEET_FIXTURE")
        .expect("set model-free Swift fixture executable");
    for version in ["v2", "v3"] {
        let cancel = AtomicBool::new(false);
        let mut worker = Worker::load(
            Path::new(&fixture),
            Path::new("/model-free-fixture"),
            "rust-swift-join",
            version,
            &cancel,
            Duration::from_secs(3),
        )
        .unwrap();
        let result = worker
            .transcribe(
                "rust-swift-join",
                version,
                &[0.25, -0.25, 0.0],
                &cancel,
                Duration::from_secs(3),
            )
            .unwrap();
        assert_eq!(result.text, "fixture transcript");
        assert_eq!(result.raw_text, "fixture transcript");
        assert_eq!(
            result.language,
            if version == "v2" {
                Some("en".into())
            } else {
                None
            }
        );
        assert_eq!(result.dropped, None);
    }
}

#[test]
fn supervisor_process_fixture() {
    let Some(path) = std::env::var_os("VOXLOOM_TEST_PARAKEET_PARENT_PIPE") else {
        return;
    };
    let path = PathBuf::from(path);
    let _worker = Worker::load(
        &path,
        Path::new("/model"),
        "parent",
        "v3",
        &AtomicBool::new(false),
        SETUP_TIMEOUT,
    )
    .unwrap();
    fs::write(path.with_extension("supervisor-ready"), b"ready").unwrap();
    // The caller kills this supervisor; still bound its lifetime if that test fails.
    std::thread::sleep(Duration::from_secs(60));
}

struct ReapOnDrop(Child);
impl Drop for ReapOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn parent_death_closes_native_pipes_for_helper_eof_watchdog() {
    let path=fixture("import threading\nload=read();open(__file__+'.pid','w').write(str(os.getpid()))\nsend(dict(protocolVersion=1,op='ready',requestId=load['requestId']))\ndef watch():\n sys.stdin.buffer.read(1)\n os._exit(0)\nthreading.Thread(target=watch,daemon=True).start()\ntime.sleep(60)");
    let parent = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("stt::parakeet::process::tests::supervisor_process_fixture")
        .env("VOXLOOM_TEST_PARAKEET_PARENT_PIPE", &path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut cleanup = ReapOnDrop(parent);
    let parent = &mut cleanup.0;
    let deadline = std::time::Instant::now() + SETUP_TIMEOUT;
    while !path.with_extension("supervisor-ready").exists() {
        if std::time::Instant::now() > deadline {
            let _ = parent.kill();
            let _ = parent.wait();
            panic!("supervisor fixture did not load");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let pid = fs::read_to_string(path.with_extension("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    parent.kill().unwrap();
    parent.wait().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    while unsafe { libc::kill(pid, 0) } == 0 {
        if std::time::Instant::now() > deadline {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            };
            panic!("helper did not exit on parent EOF");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn real_process_roundtrip_uses_framed_control_and_binary_pcm() {
    let path = fixture(NORMAL);
    let cancel = AtomicBool::new(false);
    let mut worker = Worker::load(
        &path,
        Path::new("/model"),
        "r",
        "v3",
        &cancel,
        SETUP_TIMEOUT,
    )
    .unwrap();
    let out = worker
        .transcribe(
            "r",
            "v3",
            &vec![0.25; 16000],
            &cancel,
            Duration::from_secs(2),
        )
        .unwrap();
    assert_eq!(out.text, "[Music] Thank you.");
    assert_eq!(out.language, None);
}
