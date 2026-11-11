//! Exercise real command entry points + generated ACL, not same-name stubs.
use super::*;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
fn invoke(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: window.url().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|v| v.deserialize().unwrap())
    .map_err(|e| format!("{e:?}"))
}
fn app() -> tauri::App<MockRuntime> {
    let mut state = SttState::new(
        ModelStore::new(std::env::temp_dir().join("parakeet-command-missing-model")),
        Arc::new(PcmBufferStore::new()),
    );
    state.parakeet = parakeet::ParakeetRuntime::new(parakeet::fixture(parakeet::NORMAL));
    mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            stt_prepare,
            stt_transcribe,
            stt_cancel,
            stt_release
        ])
        .build(crate::app_context())
        .unwrap()
}
fn window(app: &tauri::App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(
            if label == "main" {
                "index.html"
            } else {
                "settings.html"
            }
            .into(),
        ),
    )
    .build()
    .unwrap()
}
fn deposit(state: &SttState) -> String {
    let mut pcm = crate::capture::buffer::CaptureBuffer::new();
    pcm.push(&[0.25; 16000]).unwrap();
    state.buffers.deposit(pcm).id
}
#[test]
#[cfg(feature = "whisper")]
#[ignore = "requires VOXLOOM_TEST_TURBO_MODEL pointing to the approved pinned model"]
fn actual_commands_transcribe_verified_turbo_model() {
    let path = std::path::PathBuf::from(
        std::env::var_os("VOXLOOM_TEST_TURBO_MODEL").expect("set VOXLOOM_TEST_TURBO_MODEL"),
    );
    let spec = catalog::find(turbo::MODEL_ID).unwrap();
    assert_eq!(path.file_name().unwrap(), spec.filename);
    let state = SttState::new(
        ModelStore::new(path.parent().unwrap().to_owned()),
        Arc::new(PcmBufferStore::new()),
    );
    state.models.spawn_verify_existing(|| {}).join().unwrap();
    assert_eq!(
        state.models.status(turbo::MODEL_ID).unwrap().status,
        "available"
    );
    let app = mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            stt_prepare,
            stt_transcribe,
            stt_release
        ])
        .build(crate::app_context())
        .unwrap();
    let main = window(&app, "main");
    let state = app.state::<SttState>();
    let raw = include_bytes!("../fixtures/trim_corpus/libri_128104-0008_a0.s16");
    let samples: Vec<f32> = raw
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
        .collect();
    let mut pcm = crate::capture::buffer::CaptureBuffer::new();
    pcm.push(&samples).unwrap();
    let buffer_id = state.buffers.deposit(pcm).id;
    let request_id = "ipc-real-turbo";
    invoke(
        &main,
        "stt_prepare",
        serde_json::json!({
            "modelId": turbo::MODEL_ID, "requestId": request_id,
        }),
    )
    .expect("real native Turbo admission");
    let started = std::time::Instant::now();
    let result = invoke(
        &main,
        "stt_transcribe",
        serde_json::json!({
            "modelId": turbo::MODEL_ID, "requestId": request_id,
            "bufferId": buffer_id, "dictionary": ["Voxloom", "Notion"],
        }),
    )
    .expect("verified model resolution, actual inference and native DTO serialization");
    assert_eq!(result["language"], "en");
    assert!(result["text"].as_str().unwrap().split_whitespace().count() >= 3);
    assert!(result["rawText"].is_string());
    assert!(result["dropped"].is_null());
    assert_eq!(state.buffers.len(), 0);
    invoke(
        &main,
        "stt_release",
        serde_json::json!({
            "requestId": request_id, "bufferId": buffer_id,
        }),
    )
    .expect("idempotent final PCM and request disposal");
    eprintln!(
        "turbo_ipc_receipt={}",
        serde_json::json!({
            "modelId": turbo::MODEL_ID,
            "modelSha256": spec.sha256,
            "fixture": "libri_128104-0008_a0.s16",
            "completedMs": started.elapsed().as_millis(),
            "result": result,
        })
    );
}

#[test]
fn retirement_is_wired_to_every_native_renderer_lifecycle_callback() {
    let source = include_str!("../../lib.rs");
    for (start, end) in [
        (".on_page_load(", ".on_window_event("),
        (
            ".on_window_event(",
            "let builder = builder.on_web_content_process_terminate",
        ),
        (
            "let builder = builder.on_web_content_process_terminate",
            "let app = builder",
        ),
    ] {
        let body = source
            .split_once(start)
            .unwrap()
            .1
            .split_once(end)
            .unwrap()
            .0;
        assert!(
            body.contains("stt.turbo.retire_main("),
            "missing Turbo retirement in {start}"
        );
        assert!(
            body.contains("stt.parakeet.retire_main("),
            "missing Parakeet retirement in {start}"
        );
    }
}

#[test]
#[ignore = "requires explicitly approved complete local model sets and a packaged production helper"]
fn actual_commands_transcribe_both_verified_coreml_model_sets() {
    let model_root = std::env::var_os("VOXLOOM_PARAKEET_STORE")
        .expect("set a private model store containing the approved model IDs");
    let binary = std::env::var_os("VOXLOOM_PARAKEET_WORKER")
        .expect("set the exact packaged production helper");
    let mut state = SttState::new(
        ModelStore::new(model_root.into()),
        Arc::new(PcmBufferStore::new()),
    );
    state
        .models
        .spawn_verify_existing(|| {})
        .join()
        .expect("complete model verification must finish successfully");
    state.parakeet = parakeet::ParakeetRuntime::new(binary.into());
    let app = mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            stt_prepare,
            stt_transcribe,
            stt_release
        ])
        .build(crate::app_context())
        .unwrap();
    let main = window(&app, "main");
    let state = app.state::<SttState>();
    let raw = include_bytes!("../fixtures/trim_corpus/libri_128104-0008_a0.s16");
    let samples: Vec<f32> = raw
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0)
        .collect();
    for version in ["v2", "v3"] {
        let model_id = format!("parakeet-tdt-0.6b-{version}");
        let request_id = format!("ipc-real-{version}");
        let info = state
            .models
            .status(&model_id)
            .expect("model inventory entry");
        assert_eq!(info.status, "available");
        assert!(info.supported);
        let inventory_size = parakeet_catalog::find(&model_id).unwrap().size_bytes;
        assert_eq!(info.size_bytes, inventory_size);
        let started = std::time::Instant::now();
        invoke(
            &main,
            "stt_prepare",
            serde_json::json!({"modelId":model_id,"requestId":request_id}),
        )
        .expect("actual native prepare admission");
        let mut pcm = crate::capture::buffer::CaptureBuffer::new();
        pcm.push(&samples).unwrap();
        let buffer_id = state.buffers.deposit(pcm).id;
        let result = invoke(
            &main,
            "stt_transcribe",
            serde_json::json!({"modelId":model_id,"requestId":request_id,"bufferId":buffer_id}),
        )
        .expect("actual native routing, model resolution, Swift inference and DTO return");
        assert!(!result["text"].as_str().unwrap().trim().is_empty());
        assert_eq!(result["rawText"], result["text"]);
        assert_eq!(
            result["language"],
            if version == "v2" {
                serde_json::json!("en")
            } else {
                serde_json::Value::Null
            }
        );
        assert_eq!(state.buffers.len(), 0);
        invoke(
            &main,
            "stt_release",
            serde_json::json!({"requestId":request_id,"bufferId":buffer_id}),
        )
        .expect("idempotent final native disposal");
        eprintln!(
            "actual-coreml-command {version}: completed_ms={}",
            started.elapsed().as_millis()
        );
    }
}

#[test]
fn turbo_cancel_before_prepare_is_not_admitted() {
    let app = app();
    let main = window(&app, "main");
    invoke(
        &main,
        "stt_cancel",
        serde_json::json!({"requestId":"turbo-before"}),
    )
    .unwrap();
    let error = invoke(
        &main,
        "stt_prepare",
        serde_json::json!({
            "modelId":"whisper-large-v3-turbo", "requestId":"turbo-before"
        }),
    )
    .unwrap_err();
    assert!(error.contains("cancelled"), "{error}");
}

#[test]
fn turbo_admission_is_bounded_without_loading_and_release_frees_pending() {
    let app = app();
    let main = window(&app, "main");
    let prepare = |id: &str| {
        invoke(
            &main,
            "stt_prepare",
            serde_json::json!({
                "modelId":"whisper-large-v3-turbo", "requestId":id
            }),
        )
    };
    prepare("one").expect("admission does not load the missing model");
    prepare("one").expect("same immutable prepare is idempotent");
    prepare("two").unwrap();
    assert!(prepare("three").unwrap_err().contains("busy"));
    invoke(&main, "stt_release", serde_json::json!({"requestId":"two"})).unwrap();
    prepare("three").unwrap();
}

#[test]
fn turbo_requires_exact_preparation_and_consumes_pcm_before_refusal() {
    let app = app();
    let main = window(&app, "main");
    let state = app.state::<SttState>();
    let error = invoke(&main, "stt_transcribe", serde_json::json!({
        "modelId":"whisper-large-v3-turbo", "requestId":"not-admitted", "bufferId":deposit(&state)
    })).unwrap_err();
    assert!(error.contains("transcribe-failed"), "{error}");
    assert!(error.contains("preparation"), "{error}");
    assert_eq!(state.buffers.len(), 0);
}

#[test]
fn turbo_live_request_cannot_be_retargeted_to_tiny_or_parakeet() {
    let app = app();
    let main = window(&app, "main");
    let state = app.state::<SttState>();
    invoke(
        &main,
        "stt_prepare",
        serde_json::json!({
            "modelId":"whisper-large-v3-turbo", "requestId":"frozen"
        }),
    )
    .unwrap();
    for model in ["whisper-tiny.en", "parakeet-tdt-0.6b-v3"] {
        let error = invoke(
            &main,
            "stt_transcribe",
            serde_json::json!({
                "modelId":model, "requestId":"frozen", "bufferId":deposit(&state)
            }),
        )
        .unwrap_err();
        assert!(error.contains("immutable"), "{error}");
        assert_eq!(state.buffers.len(), 0);
    }
}

#[test]
fn turbo_cancel_release_and_epoch_refusal_dispose_exact_pcm() {
    let app = app();
    let main = window(&app, "main");
    let state = app.state::<SttState>();
    invoke(
        &main,
        "stt_prepare",
        serde_json::json!({"modelId":"whisper-large-v3-turbo", "requestId":"cancelled"}),
    )
    .unwrap();
    let first = deposit(&state);
    let other = deposit(&state);
    invoke(
        &main,
        "stt_release",
        serde_json::json!({"requestId":"cancelled", "bufferId":first}),
    )
    .unwrap();
    assert_eq!(
        state.buffers.len(),
        1,
        "release must not discard successor PCM"
    );
    assert!(state.buffers.take(&other).is_some());
    let error = invoke(&main, "stt_transcribe", serde_json::json!({"modelId":"whisper-large-v3-turbo", "requestId":"cancelled", "bufferId":deposit(&state)})).unwrap_err();
    assert!(error.contains("cancelled"));
    assert_eq!(state.buffers.len(), 0);
    invoke(
        &main,
        "stt_prepare",
        serde_json::json!({"modelId":"whisper-large-v3-turbo", "requestId":"retired"}),
    )
    .unwrap();
    let epoch = state.turbo.epoch();
    state.turbo.retire_main("main");
    let id = deposit(&state);
    assert_eq!(
        transcribe_buffer(
            &state,
            epoch,
            turbo::MODEL_ID,
            &id,
            None,
            Some("retired"),
            &[]
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
    assert_eq!(state.buffers.len(), 0);
}

#[test]
fn actual_transcribe_command_joins_prepared_worker_and_returns_existing_dto() {
    let app = app();
    let main = window(&app, "main");
    let state = app.state::<SttState>();
    let model = "parakeet-tdt-0.6b-v3";
    state
        .parakeet
        .prepare(state.parakeet.epoch(), "ready", model, "v3", || {
            Ok("/model".into())
        })
        .unwrap();
    let value = invoke(
        &main,
        "stt_transcribe",
        serde_json::json!({"modelId":model,"bufferId":deposit(&state),"requestId":"ready"}),
    )
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({"text":"[Music] Thank you.","rawText":"[Music] Thank you.","language":null,"dropped":null})
    );
    assert_eq!(state.buffers.len(), 0);
}
#[test]
fn actual_transcribe_preserves_parakeet_routing_with_dictionary_hints() {
    for dictionary in [
        serde_json::json!([]),
        serde_json::json!(["Voxloom", "Notion"]),
    ] {
        let app = app();
        let main = window(&app, "main");
        let state = app.state::<SttState>();
        let model = "parakeet-tdt-0.6b-v3";
        state
            .parakeet
            .prepare(
                state.parakeet.epoch(),
                "dictionary-ready",
                model,
                "v3",
                || Ok("/model".into()),
            )
            .unwrap();
        let value = invoke(
            &main,
            "stt_transcribe",
            serde_json::json!({
                "modelId": model, "bufferId": deposit(&state),
                "requestId": "dictionary-ready", "dictionary": dictionary
            }),
        )
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"text":"[Music] Thank you.","rawText":"[Music] Thank you.","language":null,"dropped":null})
        );
        assert_eq!(state.buffers.len(), 0);
    }
}

#[test]
fn actual_prepare_ack_is_admission_not_model_readiness_and_failure_drains_pcm() {
    let app = app();
    let main = window(&app, "main");
    let state = app.state::<SttState>();
    let model = "parakeet-tdt-0.6b-v3";
    if !parakeet_catalog::is_supported() {
        let err = invoke(
            &main,
            "stt_prepare",
            serde_json::json!({"modelId":model,"requestId":"missing"}),
        )
        .unwrap_err();
        assert!(err.contains("engine-unavailable"));
        return;
    }
    assert!(invoke(
        &main,
        "stt_prepare",
        serde_json::json!({"modelId":model,"requestId":"missing"})
    )
    .is_ok());
    let err = invoke(
        &main,
        "stt_transcribe",
        serde_json::json!({"modelId":model,"bufferId":deposit(&state),"requestId":"missing"}),
    )
    .unwrap_err();
    assert!(err.contains("model-missing"), "{err}");
    assert_eq!(state.buffers.len(), 0);
}
#[test]
fn actual_release_discards_stopped_pcm_even_without_successful_preparation() {
    let app = app();
    let main = window(&app, "main");
    let state = app.state::<SttState>();
    let buffer = deposit(&state);
    invoke(
        &main,
        "stt_release",
        serde_json::json!({"requestId":"not-admitted","bufferId":buffer}),
    )
    .unwrap();
    assert_eq!(state.buffers.len(), 0);
}
#[test]
fn actual_cancel_and_release_latch_before_prepare_and_cannot_execute_from_settings() {
    for cmd in ["stt_cancel", "stt_release"] {
        let app = app();
        let main = window(&app, "main");
        let settings = window(&app, "settings");
        assert!(invoke(&main, cmd, serde_json::json!({"requestId":"cancelled"})).is_ok());
        let err = invoke(
            &main,
            "stt_prepare",
            serde_json::json!({"modelId":"parakeet-tdt-0.6b-v3","requestId":"cancelled"}),
        )
        .unwrap_err();
        assert!(
            err.contains(if parakeet_catalog::is_supported() {
                "cancelled"
            } else {
                "engine-unavailable"
            }),
            "{err}"
        );
        assert!(invoke(&settings, cmd, serde_json::json!({"requestId":"r"}))
            .unwrap_err()
            .contains("not allowed"));
    }
}
