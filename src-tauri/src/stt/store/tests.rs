use super::*;
use std::env;
use std::fs;
use std::io::{Read as IoRead, Write as IoWrite};
use std::net::TcpListener;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Loopback (plain http) agent; production uses `model_fetch::shared_agent`.
fn test_agent() -> ureq::Agent {
    crate::model_fetch::loopback_test_agent(Duration::from_secs(10))
}

/// A catalog entry re-pinned to `body`, so loopback tests can pass verification.
fn spec_for(model_id: &str, body: &[u8]) -> ModelSpec {
    let base = *catalog::find(model_id).unwrap();
    ModelSpec {
        size_bytes: body.len() as u64,
        sha256: Box::leak(format!("{:x}", Sha256::digest(body)).into_boxed_str()),
        ..base
    }
}

fn temp_store(label: &str) -> (ModelStore, PathBuf) {
    let dir = env::temp_dir().join(format!(
        "voxloom-stt-{}-{}-{}",
        label,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::remove_dir_all(&dir);
    (ModelStore::new(dir.clone()), dir)
}

/// Serve `body` over HTTP/1.1 on a random localhost port. Optional delay
/// before each chunk so cancel races can observe inflight state.
fn serve_bytes(body: Vec<u8>, chunk_delay: Option<Duration>) -> String {
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
            if let Some(d) = chunk_delay {
                thread::sleep(d);
            }
            if stream.write_all(chunk).is_err() {
                break;
            }
        }
    });
    format!("http://127.0.0.1:{port}/model.bin")
}

#[test]
fn construct_does_not_download_or_create_network() {
    let (store, dir) = temp_store("construct");
    let list = store.list();
    assert!(!list.is_empty());
    assert!(list.iter().all(|m| m.status == "missing"));
    // Root may not even exist yet — download creates it.
    assert!(!dir.join("ggml-tiny.en.bin").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unknown_model_status_is_none() {
    let (store, dir) = temp_store("unknown");
    assert!(store.status("nope").is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cancel_when_idle_or_already_present_is_ok() {
    let (store, dir) = temp_store("cancel-idle");
    assert!(store.cancel("whisper-tiny.en").is_ok());

    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("ggml-tiny.en.bin"), b"fake").unwrap();
    assert_eq!(store.status("whisper-tiny.en").unwrap().status, "available");
    assert!(store.cancel("whisper-tiny.en").is_ok());
    assert!(dir.join("ggml-tiny.en.bin").is_file());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn download_does_not_claim_complete_before_file_finalized() {
    let body = vec![0xABu8; 8 * 1024];
    let url = serve_bytes(body.clone(), None);
    let (store, dir) = temp_store("complete-order");
    let spec = &spec_for("whisper-tiny.en", &body);

    let events: Arc<Mutex<Vec<(f64, bool)>>> = Arc::new(Mutex::new(Vec::new()));
    let events2 = Arc::clone(&events);
    let dest = store.model_path(spec);

    let result = store.download_spec_with_sink(&test_agent(), spec, &url, |p| {
        let exists = dest.is_file();
        events2.lock().unwrap().push((p.ratio, exists));
    });

    assert!(result.is_ok(), "download should succeed: {result:?}");
    assert!(dest.is_file(), "final model file must exist after Ok");
    let written = fs::read(&dest).unwrap();
    assert_eq!(written, body);

    let snapshot = events.lock().unwrap().clone();
    assert!(!snapshot.is_empty(), "expected at least one progress event");
    // No ratio==1.0 event may fire before the destination file exists.
    for (ratio, exists) in &snapshot {
        if *ratio >= 1.0 {
            assert!(
                *exists,
                "ratio 1.0 must not emit before destination file exists"
            );
        }
    }
    let last = snapshot.last().unwrap();
    assert!((last.0 - 1.0).abs() < f64::EPSILON);
    assert!(last.1);

    // Status flips to available only after completion (command returned).
    assert_eq!(store.status("whisper-tiny.en").unwrap().status, "available");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cancel_during_download_removes_partial_and_errors() {
    let body = vec![0xCDu8; 64 * 1024];
    let url = serve_bytes(body, Some(Duration::from_millis(30)));
    let (store, dir) = temp_store("cancel-inflight");
    let store = Arc::new(store);
    let spec = catalog::find("whisper-base.en").unwrap();

    let store_cancel = Arc::clone(&store);
    thread::spawn(move || {
        // Wait until inflight is registered, then cancel.
        for _ in 0..200 {
            if store_cancel.is_downloading("whisper-base.en") {
                let _ = store_cancel.cancel("whisper-base.en");
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        let _ = store_cancel.cancel("whisper-base.en");
    });

    let result = store.download_spec_with_sink(&test_agent(), spec, &url, |_| {});
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "cancelled");
    assert!(
        !dir.join("ggml-base.en.bin").exists(),
        "cancelled download must not leave a final model file"
    );
    assert!(
        !dir.join("ggml-base.en.bin.partial").exists(),
        "partial file should be cleaned up"
    );
    assert_eq!(store.status("whisper-base.en").unwrap().status, "missing");
    let _ = fs::remove_dir_all(&dir);
}

/// Declare `declared` bytes but send only `body`, then drop the connection.
fn serve_truncated(body: Vec<u8>, declared: usize) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut req = [0u8; 4096];
        let _ = stream.read(&mut req);
        let header =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n");
        stream.write_all(header.as_bytes()).unwrap();
        let _ = stream.write_all(&body);
        let _ = stream.flush();
        // Dropping the stream mid-body is the mid-stream failure.
    });
    format!("http://127.0.0.1:{port}/model.bin")
}

#[test]
fn mid_stream_failure_removes_partial_file() {
    let (store, dir) = temp_store("midstream-partial");
    let spec = catalog::find("whisper-base.en").unwrap();
    let partial = store.model_path(spec).with_extension("bin.partial");
    let url = serve_truncated(vec![7u8; 600 * 1024], 2 * 1024 * 1024);
    let mut progressed = 0u64;
    let err = store
        .download_spec_with_sink(&test_agent(), spec, &url, |p| progressed = p.bytes_received)
        .unwrap_err();
    assert_eq!(err.code, "download-failed");
    assert!(progressed > 0, "bytes were written before the failure");
    assert!(!partial.exists(), "partial file should be cleaned up");
    assert!(!store.model_path(spec).exists(), "nothing is finalized");
    assert!(store.inflight.lock().unwrap().is_none());
    assert_eq!(store.status("whisper-base.en").unwrap().status, "missing");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn failed_download_removes_partial_file_so_retry_starts_clean() {
    let (store, dir) = temp_store("failed-partial");
    fs::create_dir_all(&dir).unwrap();
    let spec = catalog::find("whisper-base.en").unwrap();
    let partial = store.model_path(spec).with_extension("bin.partial");
    fs::write(&partial, b"stale bytes").unwrap();
    // Port 9 (discard) on loopback: connection refused, no network needed.
    let err = store
        .download_spec_with_sink(&test_agent(), spec, "http://127.0.0.1:9/model.bin", |_| {})
        .unwrap_err();
    assert_eq!(err.code, "download-failed");
    assert!(!partial.exists());
    assert!(store.inflight.lock().unwrap().is_none());
    assert_eq!(store.status("whisper-base.en").unwrap().status, "missing");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn second_download_while_inflight_fails() {
    let (store, dir) = temp_store("double");
    {
        let mut guard = store.inflight.lock().unwrap();
        *guard = Some((
            "whisper-tiny.en".to_owned(),
            Inflight {
                cancel: Arc::new(AtomicBool::new(false)),
            },
        ));
    }
    let err = store
        .download_with_sink("whisper-base.en", |_| {})
        .unwrap_err();
    assert_eq!(err.code, "download-failed");
    *store.inflight.lock().unwrap() = None;
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn mismatched_download_fails_clearly_and_saves_nothing() {
    let body = vec![0x11u8; 16 * 1024];
    let (store, dir) = temp_store("mismatch");
    let pinned = spec_for("whisper-tiny.en", &body);
    let tampered = vec![0x22u8; body.len()];
    let url = serve_bytes(tampered, None);
    let mut last_ratio = 0.0;
    let err = store
        .download_spec_with_sink(&test_agent(), &pinned, &url, |p| last_ratio = p.ratio)
        .unwrap_err();
    assert_eq!(err.code, "download-failed");
    assert!(err.message.contains("did not match"), "{}", err.message);
    assert!(err.message.contains("SHA-256"), "{}", err.message);
    assert!(last_ratio < 1.0, "never reports completion on mismatch");
    assert!(!dir.join("ggml-tiny.en.bin").exists());
    assert!(!dir.join("ggml-tiny.en.bin.partial").exists());
    assert!(store.inflight.lock().unwrap().is_none());
    assert_eq!(store.status("whisper-tiny.en").unwrap().status, "missing");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn existing_unverified_model_stays_available_without_rehash() {
    // Backward compatibility: files downloaded before pinning are not
    // re-hashed or rejected; only new downloads are verified.
    let (store, dir) = temp_store("legacy-file");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("ggml-base.en.bin"), b"pre-pinning download").unwrap();
    assert_eq!(store.status("whisper-base.en").unwrap().status, "available");
    assert!(store.resolved_path("whisper-base.en").is_ok());
    let _ = fs::remove_dir_all(&dir);
}

/// Real network check of the pinned catalog (78 MB). Not run in CI:
/// `cargo test --lib real_pinned_tiny_download -- --ignored`.
#[test]
#[ignore = "downloads 78 MB from huggingface.co"]
fn real_pinned_tiny_download() {
    let (store, dir) = temp_store("real-tiny");
    store
        .download_with_sink("whisper-tiny.en", |_| {})
        .expect("pinned tiny.en download verifies");
    assert_eq!(store.status("whisper-tiny.en").unwrap().status, "available");
    let _ = fs::remove_dir_all(&dir);
}
