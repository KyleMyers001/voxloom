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
#[test]
fn stalled_load_is_killed_and_reaped_on_deadline() {
    let path = fixture("open(__file__+'.pid','w').write(str(os.getpid()))\ntime.sleep(60)");
    let cancel = AtomicBool::new(false);
    let start = std::time::Instant::now();
    assert_eq!(
        Worker::load(
            &path,
            Path::new("/model"),
            "r",
            "v3",
            &cancel,
            Duration::from_millis(150)
        )
        .err()
        .unwrap()
        .code,
        "timeout"
    );
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_reaped(&path);
}
fn assert_reaped(path: &Path) {
    let pid = fs::read_to_string(path.with_extension("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
#[test]
fn malformed_eof_oversized_and_wrong_identity_are_rejected() {
    for body in [
        "sys.stdout.buffer.write(struct.pack('<I',65537));sys.stdout.buffer.flush()",
        "sys.stdout.buffer.write(struct.pack('<I',8)+b'{}');sys.stdout.buffer.flush()",
        "v=read();send(dict(protocolVersion=1,op='ready',requestId='wrong'))",
    ] {
        let path = fixture(body);
        assert!(Worker::load(
            &path,
            Path::new("/model"),
            "r",
            "v3",
            &AtomicBool::new(false),
            Duration::from_secs(2)
        )
        .is_err());
    }
}
#[test]
fn cancellation_interrupts_load_without_waiting_for_worker() {
    let path = fixture("open(__file__+'.pid','w').write(str(os.getpid()))\ntime.sleep(60)");
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        c.store(true, Ordering::SeqCst);
    });
    assert_eq!(
        Worker::load(
            &path,
            Path::new("/model"),
            "r",
            "v3",
            &cancel,
            Duration::from_secs(60)
        )
        .err()
        .unwrap()
        .code,
        "cancelled"
    );
    t.join().unwrap();
    assert_reaped(&path);
}
#[test]
fn write_and_inference_reads_have_deadlines_and_reap_the_exact_child() {
    for body in ["load=read();r=load['requestId'];open(__file__+'.pid','w').write(str(os.getpid()));send(dict(protocolVersion=1,op='ready',requestId=r));time.sleep(60)","load=read();r=load['requestId'];open(__file__+'.pid','w').write(str(os.getpid()));send(dict(protocolVersion=1,op='ready',requestId=r));h=read();readn(h['sampleCount']*4);time.sleep(60)"] {
  let path=fixture(body);let cancel=AtomicBool::new(false);let mut worker=Worker::load(&path,Path::new("/model"),"r","v3",&cancel,Duration::from_secs(2)).unwrap();
  let start=std::time::Instant::now();assert_eq!(worker.transcribe("r","v3",&vec![0.25;super::protocol::MAX_SAMPLES],&cancel,Duration::from_millis(150)).unwrap_err().code,"timeout");drop(worker);assert_reaped(&path);assert!(start.elapsed()<Duration::from_secs(2));
 }
}
#[test]
fn cancellation_interrupts_inference_and_blocked_binary_write() {
    for body in ["load=read();r=load['requestId'];open(__file__+'.pid','w').write(str(os.getpid()));send(dict(protocolVersion=1,op='ready',requestId=r));time.sleep(60)","load=read();r=load['requestId'];open(__file__+'.pid','w').write(str(os.getpid()));send(dict(protocolVersion=1,op='ready',requestId=r));h=read();readn(h['sampleCount']*4);time.sleep(60)"] {
  let path=fixture(body);let cancel=std::sync::Arc::new(AtomicBool::new(false));let mut worker=Worker::load(&path,Path::new("/model"),"r","v3",&cancel,Duration::from_secs(2)).unwrap();let c=cancel.clone();let t=std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(150));c.store(true,Ordering::SeqCst);});
  let start=std::time::Instant::now();assert_eq!(worker.transcribe("r","v3",&vec![0.25;super::protocol::MAX_SAMPLES],&cancel,Duration::from_secs(60)).unwrap_err().code,"cancelled");drop(worker);t.join().unwrap();assert_reaped(&path);assert!(start.elapsed()<Duration::from_secs(2));
 }
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
        Duration::from_secs(2),
    )
    .unwrap();
    fs::write(path.with_extension("supervisor-ready"), b"ready").unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}
#[test]
fn parent_death_closes_native_pipes_for_helper_eof_watchdog() {
    let path=fixture("import threading\nload=read();open(__file__+'.pid','w').write(str(os.getpid()))\nsend(dict(protocolVersion=1,op='ready',requestId=load['requestId']))\ndef watch():\n sys.stdin.buffer.read(1)\n os._exit(0)\nthreading.Thread(target=watch,daemon=True).start()\ntime.sleep(60)");
    let mut parent = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("stt::parakeet::process::tests::supervisor_process_fixture")
        .env("VOXLOOM_TEST_PARAKEET_PARENT_PIPE", &path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
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
        Duration::from_secs(2),
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
