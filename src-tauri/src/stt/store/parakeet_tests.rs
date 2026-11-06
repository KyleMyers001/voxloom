use super::tests::{serve_bytes, temp_store, test_agent};
use super::ModelStore;
use crate::stt::parakeet::ModelDirs;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture(version: usize) -> (pc::ParakeetModelSpec, Vec<Vec<u8>>) {
    fixture_of(pc::CATALOG[version])
}

/// `base` re-pinned to small bodies, so loopback downloads pass verification.
fn fixture_of(base: pc::ParakeetModelSpec) -> (pc::ParakeetModelSpec, Vec<Vec<u8>>) {
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

fn install(dir: &Path, spec: &pc::ParakeetModelSpec, bodies: &[Vec<u8>]) {
    for (file, body) in spec.files.iter().zip(bodies) {
        let path = dir.join(spec.id).join(file.path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }
}

/// A store whose shared boosting set is an installed, verified fixture, so
/// a download fetches only the model set.
fn parakeet_store(label: &str) -> (ModelStore, PathBuf) {
    let (mut store, dir) = temp_store(label);
    let (vocabulary, bodies) = fixture_of(pc::VOCABULARY);
    store.parakeet_vocabulary = vocabulary;
    install(&dir, &vocabulary, &bodies);
    assert!(store.verify_parakeet_existing(&vocabulary));
    (store, dir)
}

/// Serves the fixture body of `file` in `set`; a set not listed panics.
fn url_for(
    sets: &[(pc::ParakeetModelSpec, &[Vec<u8>])],
    set: &pc::ParakeetModelSpec,
    file: &pc::ParakeetFile,
) -> String {
    let (spec, bodies) = sets
        .iter()
        .find(|(spec, _)| spec.id == set.id)
        .unwrap_or_else(|| panic!("unexpected download of {}", set.id));
    let i = spec.files.iter().position(|f| f.path == file.path).unwrap();
    serve_bytes(bodies[i].clone(), None)
}

fn dirs(store: &ModelStore, spec: &pc::ParakeetModelSpec) -> ModelDirs {
    ModelDirs {
        model: store.models_dir().join(spec.id),
        vocabulary: store.models_dir().join(store.parakeet_vocabulary.id),
    }
}

// Asset availability is platform-independent; runtime resolution is not.
fn assert_available_assets_and_platform_resolution(
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
        assert_eq!(store.parakeet_resolved(spec).unwrap(), dirs(store, spec));
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
        let (mut store, dir) = temp_store("parakeet-complete");
        let (vocabulary, vocabulary_bodies) = fixture_of(pc::VOCABULARY);
        store.parakeet_vocabulary = vocabulary;
        let (spec, bodies) = fixture(version);
        let sets = [(vocabulary, &vocabulary_bodies[..]), (spec, &bodies[..])];
        let total = spec.size_bytes + vocabulary.size_bytes;
        let mut progress = Vec::new();
        store
            .download_parakeet_spec(
                &test_agent(),
                &spec,
                |set, file| url_for(&sets, set, file),
                |p| {
                    // One download of both sets, reported as the model.
                    assert_eq!(p.model_id, spec.id);
                    assert_eq!(p.bytes_total, total);
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
        assert_eq!(progress.last().unwrap().bytes_received, total);
        assert_eq!(store.cached_parakeet_verdict(&vocabulary), Some(true));
        assert_available_assets_and_platform_resolution(&store, &spec);
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
fn parakeet_modified_component_drops_cached_trust_and_is_rechecked_without_hashing_on_resolve() {
    let (store, dir) = parakeet_store("parakeet-modified");
    let (spec, bodies) = fixture(0);
    let urls: Vec<_> = bodies
        .into_iter()
        .map(|body| serve_bytes(body, None))
        .collect();
    store
        .download_parakeet_spec(
            &test_agent(),
            &spec,
            |_, file| urls[spec.files.iter().position(|f| f.path == file.path).unwrap()].clone(),
            |_| {},
        )
        .unwrap();
    assert_eq!(store.cached_parakeet_verdict(&spec), Some(true));
    let component = dir.join(spec.id).join(spec.files[0].path);
    fs::write(&component, vec![b'x'; spec.files[0].size_bytes as usize]).unwrap();
    assert_eq!(
        store.cached_parakeet_verdict(&spec),
        None,
        "cached trust must not survive component modification"
    );
    // Like Whisper, a changed set reads as not-yet-checked (usable) and never
    // hashes on status/resolve; only the background re-check marks it failed.
    let hashing = store.hashing.lock().unwrap();
    assert_available_assets_and_platform_resolution(&store, &spec);
    drop(hashing);
    assert!(!store.verify_parakeet_existing(&spec));
    assert_eq!(store.parakeet_info(&spec).status, "failed");
    assert!(store.parakeet_resolved(&spec).is_err());
    assert!(component.exists(), "never delete damaged components");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_unverified_complete_set_is_usable_until_full_verification_detects_hash_damage() {
    let (store, dir) = parakeet_store("parakeet-existing");
    let (spec, bodies) = fixture(1);
    install(&dir, &spec, &bodies);
    // Startup hashing has not run yet: like Whisper, the set reads available
    // and resolves, so dictation and Settings never offer a re-download.
    assert_eq!(store.cached_parakeet_verdict(&spec), None);
    assert_available_assets_and_platform_resolution(&store, &spec);
    assert!(
        store.verify_parakeet_existing(&spec),
        "all production hashes must be checked"
    );
    assert_available_assets_and_platform_resolution(&store, &spec);
    fs::write(
        dir.join(spec.id).join(spec.files[0].path),
        vec![b'x'; bodies[0].len()],
    )
    .unwrap();
    assert!(!store.verify_parakeet_existing(&spec));
    assert_eq!(store.cached_parakeet_verdict(&spec), Some(false));
    let info = store.parakeet_info(&spec);
    assert_eq!(info.status, "failed");
    assert_eq!(info.failure_reason.as_deref(), Some("damaged"));
    assert_eq!(info.unavailable_reason.is_some(), !pc::is_supported());
    let error = store.parakeet_resolved(&spec).unwrap_err();
    if pc::is_supported() {
        assert_eq!(error.code, "model-missing");
        assert_eq!(error.message, super::existing::DAMAGED_MESSAGE);
    } else {
        assert_eq!(error.code, "engine-unavailable");
    }
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
    let (store, dir) = parakeet_store("parakeet-stage-tamper");
    let (spec, bodies) = fixture(0);
    fs::create_dir_all(dir.join(spec.id)).unwrap();
    fs::write(dir.join(spec.id).join("prior"), b"do not delete").unwrap();
    let mut tampered = false;
    let mut complete = false;
    let result = store.download_parakeet_spec(
        &test_agent(),
        &spec,
        |_, file| {
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
fn parakeet_changed_sets_queue_one_background_recheck_and_stay_usable_until_done() {
    let (store, dir) = parakeet_store("parakeet-recheck");
    let (spec, bodies) = fixture(1);
    install(&dir, &spec, &bodies);
    let store = std::sync::Arc::new(store);
    store.this.set(std::sync::Arc::downgrade(&store)).unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    store.set_on_models_changed(std::sync::Arc::new(move || {
        let _ = send.send(std::thread::current().id());
    }));
    let caller = std::thread::current().id();
    let hashing = store.hashing.lock().unwrap();
    for _ in 0..10 {
        assert_available_assets_and_platform_resolution(&store, &spec);
    }
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
    for _ in 0..10 {
        assert_available_assets_and_platform_resolution(&store, &spec);
    }
    drop(hashing);
    receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("changed set must be checked in background");
    assert_eq!(
        store.parakeet_info(&spec).failure_reason.as_deref(),
        Some("damaged")
    );
    assert!(store.parakeet_resolved(&spec).is_err());
    assert!(receive.try_recv().is_err(), "one callback per queued check");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_cancel_or_corrupt_download_cleans_only_new_staging_and_preserves_prior() {
    for cancel in [true, false] {
        let (store, dir) = parakeet_store("parakeet-failure");
        let (spec, bodies) = fixture(0);
        fs::create_dir_all(dir.join(spec.id)).unwrap();
        fs::write(dir.join(spec.id).join("prior"), b"retained").unwrap();
        let mut complete = false;
        let error = store
            .download_parakeet_spec(
                &test_agent(),
                &spec,
                |_, file| {
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
        let mut remaining: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        remaining.sort();
        assert_eq!(
            remaining,
            [pc::VOCABULARY.id, spec.id],
            "only the prior sets remain"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

fn leftovers(dir: &std::path::Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("staging") || name.contains("previous"))
        .collect()
}

#[test]
fn parakeet_replacement_removes_prior_backup_after_success_and_keeps_set_on_failure() {
    let (store, dir) = parakeet_store("parakeet-replace");
    let (spec, bodies) = fixture(1);
    fs::create_dir_all(dir.join(spec.id)).unwrap();
    fs::write(dir.join(spec.id).join("prior"), b"replaced").unwrap();
    let download = |corrupt: bool| {
        store.download_parakeet_spec(
            &test_agent(),
            &spec,
            |_, file| {
                let i = spec.files.iter().position(|f| f.path == file.path).unwrap();
                let body = if corrupt && i == 1 {
                    vec![b'x'; bodies[i].len()]
                } else {
                    bodies[i].clone()
                };
                serve_bytes(body, None)
            },
            |_| {},
        )
    };
    download(false).unwrap();
    assert!(!dir.join(spec.id).join("prior").exists());
    assert_eq!(
        leftovers(&dir),
        Vec::<String>::new(),
        "a verified replacement must not retain the prior set as a hidden backup"
    );
    store.cancel(spec.id).unwrap();
    assert_available_assets_and_platform_resolution(&store, &spec);
    // A failed re-download leaves the published set in place and nothing hidden.
    assert_eq!(download(true).unwrap_err().code, "download-corrupted");
    assert_eq!(leftovers(&dir), Vec::<String>::new());
    assert_available_assets_and_platform_resolution(&store, &spec);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_startup_removes_orphaned_staging_and_backups_but_nothing_else() {
    let (store, dir) = temp_store("parakeet-leftovers");
    let live = pc::CATALOG[0].id;
    let outside = temp_store("parakeet-leftovers-outside").1;
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep"), b"symlink target").unwrap();
    let orphans: Vec<String> = pc::CATALOG
        .iter()
        .chain([&pc::VOCABULARY])
        .flat_map(|spec| {
            [
                format!(".{}.staging-123-0", spec.id),
                format!(".{}.previous-123-0", spec.id),
            ]
        })
        .collect();
    for orphan in &orphans {
        fs::create_dir_all(dir.join(orphan).join("Encoder.mlmodelc")).unwrap();
        fs::write(dir.join(orphan).join("Encoder.mlmodelc/weight.bin"), b"x").unwrap();
    }
    let symlinked = format!(".{live}.previous-9-9");
    std::os::unix::fs::symlink(&outside, dir.join(&symlinked)).unwrap();
    let kept = [
        live.to_owned(),
        format!("{live}.staging-1"),
        format!(".{live}.staging"),
        format!(".{live}x.staging-1"),
        ".parakeet-unknown.previous-1".to_owned(),
        "ggml-base.en.bin".to_owned(),
    ];
    for name in &kept {
        fs::create_dir_all(dir.join(name)).unwrap();
        fs::write(dir.join(name).join("keep"), b"keep").unwrap();
    }
    // An in-flight download owns its stage: the sweep is skipped entirely.
    *store.inflight.lock().unwrap() = Some((
        "other".to_owned(),
        super::Inflight {
            cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        },
    ));
    store.remove_parakeet_leftovers();
    assert!(orphans.iter().all(|orphan| dir.join(orphan).is_dir()));
    *store.inflight.lock().unwrap() = None;

    let store = std::sync::Arc::new(store);
    store.spawn_verify_existing(|| {}).join().unwrap();
    for orphan in &orphans {
        assert!(
            fs::symlink_metadata(dir.join(orphan)).is_err(),
            "{orphan} remains"
        );
    }
    assert!(fs::symlink_metadata(dir.join(&symlinked)).is_err());
    assert_eq!(fs::read(outside.join("keep")).unwrap(), b"symlink target");
    for name in &kept {
        assert_eq!(
            fs::read(dir.join(name).join("keep")).unwrap(),
            b"keep",
            "{name}"
        );
    }
    fs::remove_dir_all(dir).unwrap();
    fs::remove_dir_all(outside).unwrap();
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
        assert_eq!(info.size_bytes, spec.size_bytes + pc::VOCABULARY.size_bytes);
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

#[test]
fn parakeet_install_from_before_boosting_reads_missing_and_downloads_only_the_shared_set() {
    let (mut store, dir) = temp_store("parakeet-upgrade");
    let (vocabulary, vocabulary_bodies) = fixture_of(pc::VOCABULARY);
    store.parakeet_vocabulary = vocabulary;
    let models: Vec<_> = (0..2).map(fixture).collect();
    for (spec, bodies) in &models {
        install(&dir, spec, bodies);
        assert!(store.verify_parakeet_existing(spec));
        let info = store.parakeet_info(spec);
        assert_eq!(info.status, "missing");
        assert_eq!(info.failure_reason, None);
        if pc::is_supported() {
            let error = store.parakeet_resolved(spec).unwrap_err();
            assert_eq!(error.code, "model-missing");
        }
    }
    let spec = models[0].0;
    let component = dir.join(spec.id).join(spec.files[0].path);
    let installed = fs::read(&component).unwrap();
    // A model file request would panic in `url_for`.
    let sets = [(vocabulary, &vocabulary_bodies[..])];
    let mut progress = Vec::new();
    store
        .download_parakeet_spec(
            &test_agent(),
            &spec,
            |set, file| url_for(&sets, set, file),
            |p| progress.push(p),
        )
        .unwrap();
    assert!(progress
        .iter()
        .all(|p| p.model_id == spec.id && p.bytes_total == vocabulary.size_bytes));
    assert_eq!(progress.last().unwrap().ratio, 1.0);
    assert_eq!(fs::read(&component).unwrap(), installed);
    // Stored once, for both models.
    for (spec, _) in &models {
        assert_available_assets_and_platform_resolution(&store, spec);
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_damaged_shared_set_fails_installed_models_and_is_downloaded_again_alone() {
    let (store, dir) = parakeet_store("parakeet-shared-damage");
    let (installed, bodies) = fixture(0);
    install(&dir, &installed, &bodies);
    assert!(store.verify_parakeet_existing(&installed));
    let (absent, _) = fixture(1);
    let vocabulary = store.parakeet_vocabulary;
    let (_, vocabulary_bodies) = fixture_of(pc::VOCABULARY);
    fs::write(
        dir.join(vocabulary.id).join(vocabulary.files[0].path),
        vec![b'x'; vocabulary_bodies[0].len()],
    )
    .unwrap();
    // The startup pass checks the shared set too.
    let store = std::sync::Arc::new(store);
    store.spawn_verify_existing(|| {}).join().unwrap();
    assert_eq!(store.cached_parakeet_verdict(&vocabulary), Some(false));
    let info = store.parakeet_info(&installed);
    assert_eq!(info.status, "failed");
    assert_eq!(info.failure_reason.as_deref(), Some("damaged"));
    if pc::is_supported() {
        let error = store.parakeet_resolved(&installed).unwrap_err();
        assert_eq!(error.message, super::existing::DAMAGED_MESSAGE);
    }
    // A model never downloaded is only missing.
    assert_eq!(store.parakeet_info(&absent).status, "missing");
    let sets = [(vocabulary, &vocabulary_bodies[..])];
    store
        .download_parakeet_spec(
            &test_agent(),
            &installed,
            |set, file| url_for(&sets, set, file),
            |_| {},
        )
        .unwrap();
    assert_available_assets_and_platform_resolution(&store, &installed);
    assert_eq!(leftovers(&dir), Vec::<String>::new());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn parakeet_shared_set_published_first_survives_a_failed_model_download() {
    let (mut store, dir) = temp_store("parakeet-partial");
    let (vocabulary, vocabulary_bodies) = fixture_of(pc::VOCABULARY);
    store.parakeet_vocabulary = vocabulary;
    let (spec, bodies) = fixture(1);
    let corrupt: Vec<_> = bodies.iter().map(|body| vec![b'x'; body.len()]).collect();
    let changed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = std::sync::Arc::clone(&changed);
    store.set_on_models_changed(std::sync::Arc::new(move || {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    let sets = [(vocabulary, &vocabulary_bodies[..]), (spec, &corrupt[..])];
    let error = store
        .download_parakeet_spec(
            &test_agent(),
            &spec,
            |set, file| url_for(&sets, set, file),
            |_| {},
        )
        .unwrap_err();
    assert_eq!(error.code, "download-corrupted");
    // The other model may already have been usable with it: re-list.
    assert_eq!(changed.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(store.cached_parakeet_verdict(&vocabulary), Some(true));
    assert!(!dir.join(spec.id).exists());
    assert_eq!(store.parakeet_info(&spec).status, "missing");
    assert!(store.inflight.lock().unwrap().is_none());
    assert_eq!(leftovers(&dir), Vec::<String>::new());
    // Trying again fetches only the model set.
    let sets = [(spec, &bodies[..])];
    store
        .download_parakeet_spec(
            &test_agent(),
            &spec,
            |set, file| url_for(&sets, set, file),
            |_| {},
        )
        .unwrap();
    assert_available_assets_and_platform_resolution(&store, &spec);
    fs::remove_dir_all(dir).unwrap();
}
