use super::tests::{serve_bytes, temp_store, test_agent};
use super::ModelStore;
use sha2::{Digest, Sha256};
use std::fs;

fn fixture(version: usize) -> (pc::ParakeetModelSpec, Vec<Vec<u8>>) {
    let base = pc::CATALOG[version];
    let bodies: Vec<Vec<u8>> = base
        .files
        .iter()
        .enumerate()
        .map(|(i, _)| format!("fixture-component-{i}").into_bytes())
        .collect();
    let files: Vec<_> = base
        .files
        .iter()
        .zip(&bodies)
        .map(|(file, body)| pc::ParakeetFile {
            path: file.path,
            size_bytes: body.len() as u64,
            sha256: Box::leak(format!("{:x}", Sha256::digest(body)).into_boxed_str()),
        })
        .collect();
    (
        pc::ParakeetModelSpec {
            size_bytes: files.iter().map(|f| f.size_bytes).sum(),
            files: Box::leak(files.into_boxed_slice()),
            ..base
        },
        bodies,
    )
}

// Asset verification is platform-independent; runtime resolution is not.
fn assert_verified_assets_and_platform_resolution(
    store: &ModelStore,
    spec: &pc::ParakeetModelSpec,
) {
    let info = store.parakeet_info(spec);
    assert_eq!(info.status, "available");
    assert!(store.models_dir().join(spec.id).is_dir());
    assert_eq!(info.failure_reason, None);
    assert_eq!(info.supported, pc::is_supported());
    if pc::is_supported() {
        assert_eq!(info.unavailable_reason, None);
        assert_eq!(
            store.parakeet_resolved(spec).unwrap(),
            store.models_dir().join(spec.id)
        );
    } else {
        assert_eq!(
            info.unavailable_reason.as_deref(),
            Some(pc::UNAVAILABLE_REASON)
        );
        let error = store.parakeet_resolved(spec).unwrap_err();
        assert_eq!(error.code, "engine-unavailable");
        assert_eq!(error.message, pc::UNAVAILABLE_REASON);
    }
}

#[test]
fn parakeet_complete_download_is_staged_verified_and_reports_aggregate_progress() {
    for version in 0..2 {
        let (store, dir) = temp_store("parakeet-complete");
        let (spec, bodies) = fixture(version);
        let urls: Vec<_> = bodies
            .into_iter()
            .map(|body| serve_bytes(body, None))
            .collect();
        let mut progress = Vec::new();
        store
            .download_parakeet_spec(
                &test_agent(),
                &spec,
                |file| urls[spec.files.iter().position(|f| f.path == file.path).unwrap()].clone(),
                |p| {
                    assert_eq!(p.bytes_total, spec.size_bytes);
                    if p.ratio < 1.0 {
                        assert!(!dir.join(spec.id).exists(), "no partially installed set");
                    } else {
                        assert!(dir.join(spec.id).join("parakeet_vocab.json").is_file());
                    }
                    progress.push(p);
                },
            )
            .unwrap();
        assert!(progress
            .windows(2)
            .all(|p| p[0].bytes_received <= p[1].bytes_received));
        assert_eq!(progress.last().unwrap().ratio, 1.0);
        assert_eq!(progress.last().unwrap().bytes_received, spec.size_bytes);
        assert_verified_assets_and_platform_resolution(&store, &spec);
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("staging")));
        fs::remove_dir_all(dir).unwrap();
    }
}

use crate::stt::parakeet_catalog as pc;

#[test]
fn parakeet_modified_component_immediately_revokes_readiness_without_hashing_on_resolve() {
    let (store, dir) = temp_store("parakeet-modified");
    let (spec, bodies) = fixture(0);
    let urls: Vec<_> = bodies
        .into_iter()
        .map(|body| serve_bytes(body, None))
        .collect();
    store
        .download_parakeet_spec(
            &test_agent(),
            &spec,
            |file| urls[spec.files.iter().position(|f| f.path == file.path).unwrap()].clone(),
            |_| {},
        )
        .unwrap();
    let component = dir.join(spec.id).join(spec.files[0].path);
    fs::write(&component, vec![b'x'; spec.files[0].size_bytes as usize]).unwrap();
    assert_ne!(store.parakeet_info(&spec).status, "available");
    assert!(
        store.parakeet_resolved(&spec).is_err(),
        "cached trust must not survive component modification"
    );
    assert!(component.exists(), "never delete damaged components");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_existing_complete_set_requires_full_verification_and_detects_hash_damage() {
    let (store, dir) = temp_store("parakeet-existing");
    let (spec, bodies) = fixture(1);
    for (file, body) in spec.files.iter().zip(&bodies) {
        let path = dir.join(spec.id).join(file.path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }
    assert_eq!(
        store.parakeet_info(&spec).status,
        "missing",
        "unverified is never available"
    );
    assert_eq!(
        store.parakeet_resolved(&spec).unwrap_err().code,
        if pc::is_supported() {
            "model-missing"
        } else {
            "engine-unavailable"
        }
    );
    assert!(
        store.verify_parakeet_existing(&spec),
        "all production hashes must be checked"
    );
    assert_verified_assets_and_platform_resolution(&store, &spec);
    fs::write(
        dir.join(spec.id).join(spec.files[0].path),
        vec![b'x'; bodies[0].len()],
    )
    .unwrap();
    assert!(!store.verify_parakeet_existing(&spec));
    let info = store.parakeet_info(&spec);
    assert_eq!(info.status, "failed");
    assert_eq!(info.failure_reason.as_deref(), Some("damaged"));
    assert_eq!(
        store.parakeet_resolved(&spec).unwrap_err().code,
        if pc::is_supported() {
            "model-missing"
        } else {
            "engine-unavailable"
        }
    );
    assert!(
        dir.join(spec.id).exists(),
        "never repair/delete existing damaged sets"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_incomplete_extra_or_symlinked_sets_are_damaged_not_silently_repaired() {
    for damage in ["missing", "extra", "directory-symlink", "root-symlink"] {
        let (store, dir) = temp_store("parakeet-structure");
        let (spec, bodies) = fixture(0);
        let installed = dir.join(spec.id);
        for (file, body) in spec.files.iter().zip(&bodies) {
            let path = installed.join(file.path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
        match damage {
            "missing" => {
                fs::remove_file(installed.join(spec.files[0].path)).unwrap();
            }
            "extra" => {
                fs::write(
                    installed.join("CtcHead.mlmodelc"),
                    b"unpinned optional model",
                )
                .unwrap();
            }
            "directory-symlink" => {
                let original = installed.join("Encoder.mlmodelc");
                let target = dir.join("encoder-external");
                fs::rename(&original, &target).unwrap();
                std::os::unix::fs::symlink(&target, &original).unwrap();
            }
            "root-symlink" => {
                let target = dir.join("external-set");
                fs::rename(&installed, &target).unwrap();
                std::os::unix::fs::symlink(&target, &installed).unwrap();
            }
            _ => unreachable!(),
        }
        let info = store.parakeet_info(&spec);
        assert_eq!(info.status, "failed", "{damage}");
        assert_eq!(info.failure_reason.as_deref(), Some("damaged"), "{damage}");
        assert!(!store.verify_parakeet_existing(&spec), "{damage}");
        assert!(store.parakeet_resolved(&spec).is_err());
        assert!(
            fs::symlink_metadata(installed).is_ok(),
            "do not repair/delete existing sets"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn parakeet_startup_reports_existing_damaged_set_from_background_thread() {
    let (store, dir) = temp_store("parakeet-startup");
    let spec = pc::CATALOG[0];
    fs::create_dir_all(dir.join(spec.id)).unwrap();
    let store = std::sync::Arc::new(store);
    let (send, receive) = std::sync::mpsc::channel();
    let caller = std::thread::current().id();
    store
        .spawn_verify_existing(move || {
            send.send(std::thread::current().id()).unwrap();
        })
        .join()
        .unwrap();
    assert_ne!(
        receive
            .try_recv()
            .expect("Parakeet startup verdict must notify"),
        caller
    );
    assert_eq!(store.status(spec.id).unwrap().status, "failed");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_reverifies_staged_set_before_publication_and_preserves_prior_on_failure() {
    let (store, dir) = temp_store("parakeet-stage-tamper");
    let (spec, bodies) = fixture(0);
    fs::create_dir_all(dir.join(spec.id)).unwrap();
    fs::write(dir.join(spec.id).join("prior"), b"do not delete").unwrap();
    let mut tampered = false;
    let mut complete = false;
    let result = store.download_parakeet_spec(
        &test_agent(),
        &spec,
        |file| {
            serve_bytes(
                bodies[spec.files.iter().position(|f| f.path == file.path).unwrap()].clone(),
                None,
            )
        },
        |p| {
            complete |= p.ratio == 1.0;
            if !tampered && p.bytes_received > spec.files[0].size_bytes {
                let stage = fs::read_dir(&dir)
                    .unwrap()
                    .find_map(|e| {
                        let e = e.unwrap();
                        e.file_name()
                            .to_string_lossy()
                            .contains("staging")
                            .then(|| e.path())
                    })
                    .unwrap();
                fs::write(stage.join(spec.files[0].path), vec![b'x'; bodies[0].len()]).unwrap();
                tampered = true;
            }
        },
    );
    assert_eq!(result.unwrap_err().code, "download-corrupted");
    assert!(!complete);
    assert_eq!(
        fs::read(dir.join(spec.id).join("prior")).unwrap(),
        b"do not delete"
    );
    assert!(fs::read_dir(&dir).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains("staging")));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_changed_sets_queue_one_background_recheck_and_refuse_until_done() {
    let (store, dir) = temp_store("parakeet-recheck");
    let (spec, bodies) = fixture(1);
    for (file, body) in spec.files.iter().zip(&bodies) {
        let path = dir.join(spec.id).join(file.path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }
    let store = std::sync::Arc::new(store);
    store.this.set(std::sync::Arc::downgrade(&store)).unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    store.set_on_models_changed(std::sync::Arc::new(move || {
        let _ = send.send(std::thread::current().id());
    }));
    let caller = std::thread::current().id();
    let hashing = store.hashing.lock().unwrap();
    for _ in 0..10 {
        assert_eq!(store.parakeet_info(&spec).status, "missing");
    }
    assert!(store.parakeet_resolved(&spec).is_err());
    drop(hashing);
    assert_ne!(
        receive
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("queued verification must notify"),
        caller
    );
    assert_eq!(store.parakeet_info(&spec).status, "available");
    fs::write(
        dir.join(spec.id).join(spec.files[0].path),
        vec![b'x'; bodies[0].len()],
    )
    .unwrap();
    let hashing = store.hashing.lock().unwrap();
    assert!(store.parakeet_resolved(&spec).is_err());
    for _ in 0..10 {
        assert_eq!(store.parakeet_info(&spec).status, "missing");
    }
    drop(hashing);
    receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("changed set must be checked in background");
    assert_eq!(
        store.parakeet_info(&spec).failure_reason.as_deref(),
        Some("damaged")
    );
    assert!(receive.try_recv().is_err(), "one callback per queued check");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_cancel_or_corrupt_download_cleans_only_new_staging_and_preserves_prior() {
    for cancel in [true, false] {
        let (store, dir) = temp_store("parakeet-failure");
        let (spec, bodies) = fixture(0);
        fs::create_dir_all(dir.join(spec.id)).unwrap();
        fs::write(dir.join(spec.id).join("prior"), b"retained").unwrap();
        let mut complete = false;
        let error = store
            .download_parakeet_spec(
                &test_agent(),
                &spec,
                |file| {
                    let i = spec.files.iter().position(|f| f.path == file.path).unwrap();
                    let body = if !cancel && i == 1 {
                        vec![b'x'; bodies[i].len()]
                    } else {
                        bodies[i].clone()
                    };
                    serve_bytes(body, None)
                },
                |p| {
                    complete |= p.ratio == 1.0;
                    if cancel && p.bytes_received > spec.files[0].size_bytes {
                        store.cancel(spec.id).unwrap();
                    }
                },
            )
            .unwrap_err();
        assert_eq!(
            error.code,
            if cancel {
                "cancelled"
            } else {
                "download-corrupted"
            }
        );
        assert!(!complete);
        assert!(store.inflight.lock().unwrap().is_none());
        assert_eq!(
            fs::read(dir.join(spec.id).join("prior")).unwrap(),
            b"retained"
        );
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "only prior set remains"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn parakeet_explicit_replacement_retains_prior_directory_and_idle_cancel_keeps_new_set() {
    let (store, dir) = temp_store("parakeet-replace");
    let (spec, bodies) = fixture(1);
    fs::create_dir_all(dir.join(spec.id)).unwrap();
    fs::write(dir.join(spec.id).join("prior"), b"retained").unwrap();
    store
        .download_parakeet_spec(
            &test_agent(),
            &spec,
            |file| {
                serve_bytes(
                    bodies[spec.files.iter().position(|f| f.path == file.path).unwrap()].clone(),
                    None,
                )
            },
            |_| {},
        )
        .unwrap();
    let prior = fs::read_dir(&dir)
        .unwrap()
        .find_map(|e| {
            let e = e.unwrap();
            e.file_name()
                .to_string_lossy()
                .contains("previous")
                .then(|| e.path())
        })
        .expect("prior set must be retained");
    assert_eq!(fs::read(prior.join("prior")).unwrap(), b"retained");
    store.cancel(spec.id).unwrap();
    assert_verified_assets_and_platform_resolution(&store, &spec);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_models_are_listed_missing_without_network_and_cancel_is_idle_safe() {
    let (store, dir) = temp_store("parakeet-list");
    let list = store.list();
    for spec in pc::CATALOG {
        let info = store
            .status(spec.id)
            .expect("Parakeet catalog entry is supported by store");
        assert_eq!(info.status, "missing");
        assert!(list.iter().any(|row| row.id == spec.id));
        assert_eq!(info.size_bytes, spec.size_bytes);
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["supported"], pc::is_supported());
        assert!(store.cancel(spec.id).is_ok());
        assert!(store.resolved_path(spec.id).is_err());
    }
    assert!(
        !dir.exists(),
        "listing and cancellation must not create directories"
    );
}
