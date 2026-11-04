use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::super::pin::MODEL_FILE;
use super::super::{ArtifactSpec, CleanupModelStore, MODEL_ID};
use super::{DownloadError, DownloadProgress};
use crate::model_fetch::{loopback_test_agent, partial_path};

const BODY: &[u8] = b"GGUF cleanup model bytes for the download tests";

fn root(name: &str) -> PathBuf {
    let root = crate::cleanup::test_support::test_root().join(format!("model-download-{name}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn spec(bytes: &[u8]) -> ArtifactSpec {
    ArtifactSpec {
        sha256: Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str()),
        size: bytes.len() as u64,
    }
}

/// One-shot loopback server; `delay` slows each 8-byte chunk.
fn serve(body: Vec<u8>, delay: Option<Duration>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let _ = stream.read(&mut [0u8; 4096]);
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        for chunk in body.chunks(8) {
            if let Some(delay) = delay {
                thread::sleep(delay);
            }
            if stream.write_all(chunk).is_err() {
                break;
            }
        }
    });
    format!("http://127.0.0.1:{port}/model.gguf")
}

fn closed_url() -> String {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    format!("http://127.0.0.1:{port}/model.gguf")
}

fn run(
    store: &CleanupModelStore,
    url: &str,
    artifact: ArtifactSpec,
) -> (Result<(), DownloadError>, Vec<DownloadProgress>) {
    let agent = loopback_test_agent(Duration::from_secs(5));
    let mut seen = Vec::new();
    let result = store.download_from(&agent, url, artifact, |p| seen.push(p), |_| Ok(()));
    (result, seen)
}

fn assert_nothing_left(store: &CleanupModelStore) {
    let dest = store.model_path();
    assert!(!dest.exists(), "no model file may be left");
    assert!(!partial_path(&dest).exists(), "no partial file may be left");
}

#[test]
fn success_installs_a_private_verified_model_and_reports_completion_last() {
    let store = CleanupModelStore::new(root("success").join("installed"));
    let (result, seen) = run(&store, &serve(BODY.to_vec(), None), spec(BODY));
    result.unwrap();
    let dest = store.model_path();
    assert_eq!(fs::read(&dest).unwrap(), BODY);
    assert!(!partial_path(&dest).exists());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let (last, earlier) = seen.split_last().unwrap();
    assert_eq!(last.ratio, 1.0);
    assert!(earlier.iter().all(|p| p.ratio < 1.0));
    assert!(store.status_available_for(spec(BODY)));
    assert!(!store.cancel_download(), "no download is running anymore");
}

#[test]
fn hash_or_size_mismatch_is_a_checksum_error_and_leaves_nothing() {
    let store = CleanupModelStore::new(root("mismatch").join("installed"));
    let mut tampered = BODY.to_vec();
    tampered[0] ^= 1;
    let (result, _) = run(&store, &serve(tampered, None), spec(BODY));
    assert_eq!(result, Err(DownloadError::Checksum));
    assert_nothing_left(&store);
    let (result, _) = run(&store, &serve(BODY[..10].to_vec(), None), spec(BODY));
    assert_eq!(result, Err(DownloadError::Checksum));
    assert_nothing_left(&store);
}

#[test]
fn offline_is_a_failure_that_leaves_nothing_and_a_retry_succeeds() {
    let store = CleanupModelStore::new(root("offline").join("installed"));
    let (result, _) = run(&store, &closed_url(), spec(BODY));
    assert!(matches!(result, Err(DownloadError::Failed(ref m)) if !m.is_empty()));
    assert_nothing_left(&store);
    let (retry, _) = run(&store, &serve(BODY.to_vec(), None), spec(BODY));
    retry.unwrap();
    assert_eq!(fs::read(store.model_path()).unwrap(), BODY);
}

#[test]
fn failure_never_touches_an_existing_file() {
    let store = CleanupModelStore::new(root("existing").join("installed"));
    fs::create_dir_all(&store.root).unwrap();
    fs::write(store.model_path(), b"older bytes").unwrap();
    let mut tampered = BODY.to_vec();
    tampered[3] ^= 1;
    let (result, _) = run(&store, &serve(tampered, None), spec(BODY));
    assert_eq!(result, Err(DownloadError::Checksum));
    assert_eq!(fs::read(store.model_path()).unwrap(), b"older bytes");
    assert!(!partial_path(&store.model_path()).exists());
}

#[test]
fn an_installed_model_is_kept_without_any_request() {
    let store = CleanupModelStore::new(root("installed").join("installed"));
    fs::create_dir_all(&store.root).unwrap();
    fs::write(store.model_path(), BODY).unwrap();
    let (result, seen) = run(&store, &closed_url(), spec(BODY));
    result.unwrap();
    assert_eq!(fs::read(store.model_path()).unwrap(), BODY);
    assert_eq!(seen.last().unwrap().ratio, 1.0);
}

#[test]
fn cancel_mid_stream_removes_everything_and_blocks_import_meanwhile() {
    let base = root("cancel");
    let store = Arc::new(CleanupModelStore::new(base.join("installed")));
    let body = vec![7u8; 4096];
    let url = serve(body.clone(), Some(Duration::from_millis(5)));
    let worker = {
        let store = Arc::clone(&store);
        let artifact = spec(&body);
        thread::spawn(move || run(&store, &url, artifact).0)
    };
    let started = Instant::now();
    while !partial_path(&store.model_path()).exists() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "download never started"
        );
        thread::sleep(Duration::from_millis(5));
    }
    let source = base.join("source.gguf");
    fs::write(&source, BODY).unwrap();
    let import = store.import_artifact(&source, spec(BODY)).unwrap_err();
    assert!(import.contains("already running"), "{import}");
    assert!(store.lease(MODEL_ID).is_err(), "no lease while downloading");
    assert!(store.cancel_download());
    assert_eq!(worker.join().unwrap(), Err(DownloadError::Cancelled));
    assert_nothing_left(&store);
    assert!(!store.cancel_download());
    // Import works again once the download is gone.
    store.import_artifact(&source, spec(BODY)).unwrap();
}

#[test]
fn a_held_lease_refuses_the_download() {
    let store = CleanupModelStore::new(root("leased").join("installed"));
    fs::create_dir_all(&store.root).unwrap();
    fs::write(store.root.join(MODEL_FILE), BODY).unwrap();
    let _lease = store.lease(MODEL_ID).unwrap();
    let (result, _) = run(&store, &closed_url(), spec(BODY));
    assert!(matches!(result, Err(DownloadError::Failed(ref m)) if m.contains("in use")));
    assert_eq!(fs::read(store.model_path()).unwrap(), BODY);
}
