use super::*;
use std::env;
use std::io::{Read as IoRead, Write as IoWrite};
use std::net::TcpListener;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn agent() -> ureq::Agent {
    loopback_test_agent(Duration::from_secs(10))
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = env::temp_dir().join(format!(
        "voxloom-fetch-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn sha_hex(bytes: &[u8]) -> &'static str {
    Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str())
}

fn pinned(bytes: &[u8]) -> PinnedArtifact {
    PinnedArtifact {
        size_bytes: bytes.len() as u64,
        sha256: sha_hex(bytes),
    }
}

/// Serve `body` once over HTTP/1.1 with an optional per-KiB delay.
fn serve(body: Vec<u8>, delay: Option<Duration>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut req = [0u8; 4096];
        let _ = stream.read(&mut req);
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(header.as_bytes()).unwrap();
        for chunk in body.chunks(1024) {
            if let Some(d) = delay {
                thread::sleep(d);
            }
            if stream.write_all(chunk).is_err() {
                break;
            }
        }
    });
    format!("http://127.0.0.1:{port}/artifact.bin")
}

fn assert_clean(dest: &Path) {
    assert!(!dest.exists(), "nothing may be finalized");
    assert!(!partial_path(dest).exists(), "partial must be removed");
}

#[test]
fn partial_path_appends_suffix() {
    let p = partial_path(Path::new("/m/ggml-tiny.en.bin"));
    assert_eq!(p, Path::new("/m/ggml-tiny.en.bin.partial"));
}

#[test]
fn success_writes_verified_file_and_reports_progress_before_rename() {
    let body: Vec<u8> = (0..600 * 1024u32).map(|i| (i % 251) as u8).collect();
    let dir = temp_dir("ok");
    let dest = dir.join("model.bin");
    let mut events = Vec::new();
    fetch_verified(
        &agent(),
        &serve(body.clone(), None),
        &dest,
        &pinned(&body),
        &AtomicBool::new(false),
        |received, total| events.push((received, total, dest.exists())),
    )
    .expect("verified download");
    assert_eq!(fs::read(&dest).unwrap(), body);
    assert!(!partial_path(&dest).exists());
    assert!(!events.is_empty());
    assert!(events
        .iter()
        .all(|(_, t, exists)| *t == body.len() as u64 && !exists));
    assert_eq!(events.last().unwrap().0, body.len() as u64);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn hash_mismatch_deletes_partial_and_reports_digests() {
    let body = vec![1u8; 4096];
    let mut tampered = body.clone();
    tampered[100] = 2;
    let dir = temp_dir("hash");
    let dest = dir.join("model.bin");
    let err = fetch_verified(
        &agent(),
        &serve(tampered.clone(), None),
        &dest,
        &pinned(&body),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap_err();
    match err {
        FetchError::HashMismatch { expected, actual } => {
            assert_eq!(expected, sha_hex(&body));
            assert_eq!(actual, sha_hex(&tampered));
        }
        other => panic!("expected hash mismatch, got {other:?}"),
    }
    assert_clean(&dest);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn short_body_is_a_size_mismatch() {
    let expected = vec![3u8; 8192];
    let dir = temp_dir("short");
    let dest = dir.join("model.bin");
    let err = fetch_verified(
        &agent(),
        &serve(expected[..5000].to_vec(), None),
        &dest,
        &pinned(&expected),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap_err();
    assert_eq!(
        err,
        FetchError::SizeMismatch {
            expected: 8192,
            actual: 5000
        }
    );
    assert_clean(&dest);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn oversized_body_stops_at_the_pinned_size() {
    let expected = vec![4u8; 2048];
    let dir = temp_dir("long");
    let dest = dir.join("model.bin");
    let err = fetch_verified(
        &agent(),
        &serve(vec![4u8; 512 * 1024], None),
        &dest,
        &pinned(&expected),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap_err();
    match err {
        FetchError::SizeMismatch { expected, actual } => {
            assert_eq!(expected, 2048);
            assert!(
                actual > 2048 && actual < 512 * 1024,
                "aborts early: {actual}"
            );
        }
        other => panic!("expected size mismatch, got {other:?}"),
    }
    assert_clean(&dest);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cancel_mid_stream_removes_partial() {
    let body = vec![5u8; 128 * 1024];
    let dir = temp_dir("cancel");
    let dest = dir.join("model.bin");
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    let partial = partial_path(&dest);
    let watcher = thread::spawn(move || {
        for _ in 0..400 {
            if partial.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        flag.store(true, Ordering::Release);
    });
    let err = fetch_verified(
        &agent(),
        &serve(body.clone(), Some(Duration::from_millis(10))),
        &dest,
        &pinned(&body),
        &cancel,
        |_, _| {},
    )
    .unwrap_err();
    watcher.join().unwrap();
    assert_eq!(err, FetchError::Cancelled);
    assert_clean(&dest);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn network_failure_removes_stale_partial() {
    let dir = temp_dir("refused");
    fs::create_dir_all(&dir).unwrap();
    let dest = dir.join("model.bin");
    fs::write(partial_path(&dest), b"stale").unwrap();
    let err = fetch_verified(
        &agent(),
        "http://127.0.0.1:9/artifact.bin",
        &dest,
        &pinned(b"x"),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap_err();
    assert!(matches!(err, FetchError::Network(_)));
    assert_clean(&dest);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn verify_file_checks_size_then_hash() {
    let dir = temp_dir("verify");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("model.bin");
    let body = b"pinned model bytes".to_vec();
    fs::write(&path, &body).unwrap();
    assert_eq!(verify_file(&path, &pinned(&body)), Ok(()));

    let wrong_size = PinnedArtifact {
        size_bytes: 3,
        sha256: sha_hex(&body),
    };
    assert!(matches!(
        verify_file(&path, &wrong_size),
        Err(FetchError::SizeMismatch { expected: 3, .. })
    ));

    let wrong_hash = PinnedArtifact {
        size_bytes: body.len() as u64,
        sha256: sha_hex(b"other bytes......."),
    };
    assert!(matches!(
        verify_file(&path, &wrong_hash),
        Err(FetchError::HashMismatch { .. })
    ));
    let _ = fs::remove_dir_all(&dir);
}

/// Serve headers plus `prefix`, then hold the socket open without sending more.
fn serve_then_stall(total_len: usize, prefix: Vec<u8>, hold: Duration) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut req = [0u8; 4096];
        let _ = stream.read(&mut req);
        let header =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {total_len}\r\nConnection: close\r\n\r\n");
        stream.write_all(header.as_bytes()).unwrap();
        stream.write_all(&prefix).unwrap();
        stream.flush().unwrap();
        thread::sleep(hold);
    });
    format!("http://127.0.0.1:{port}/artifact.bin")
}

#[test]
fn stalled_body_times_out_and_removes_partial() {
    let body = vec![6u8; 64 * 1024];
    let dir = temp_dir("stall");
    let dest = dir.join("model.bin");
    let url = serve_then_stall(body.len(), body[..4096].to_vec(), Duration::from_secs(5));
    let started = std::time::Instant::now();
    let err = fetch_verified(
        &loopback_test_agent(Duration::from_millis(200)),
        &url,
        &dest,
        &pinned(&body),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "read timeout must fire, not wait for the server: {:?}",
        started.elapsed()
    );
    match err {
        FetchError::Network(msg) => assert!(msg.starts_with("read failed"), "{msg}"),
        other => panic!("expected read timeout, got {other:?}"),
    }
    assert_clean(&dest);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn shared_agent_refuses_plain_http_before_connecting() {
    // Listener that would accept: proves the refusal is the agent's policy,
    // not a connection failure. Covers https→http redirects too, since ureq
    // applies `https_only` to every hop.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let dir = temp_dir("https-only");
    fs::create_dir_all(&dir).unwrap();
    let dest = dir.join("model.bin");
    fs::write(partial_path(&dest), b"stale").unwrap();
    let err = fetch_verified(
        shared_agent(),
        &format!("http://127.0.0.1:{port}/artifact.bin"),
        &dest,
        &pinned(b"x"),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap_err();
    match err {
        FetchError::Network(msg) => assert!(msg.contains("https_only"), "{msg}"),
        other => panic!("expected https_only refusal, got {other:?}"),
    }
    listener.set_nonblocking(true).unwrap();
    assert!(listener.accept().is_err(), "no connection may be attempted");
    assert_clean(&dest);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn shared_agent_has_explicit_timeouts() {
    let config = format!("{:?}", shared_agent());
    assert!(config.contains("timeout_connect: Some(30s)"), "{config}");
    assert!(config.contains("timeout_read: Some(30s)"), "{config}");
    assert!(
        config.contains("timeout: None"),
        "no overall deadline: {config}"
    );
    assert!(config.contains("https_only: true"), "{config}");
}
