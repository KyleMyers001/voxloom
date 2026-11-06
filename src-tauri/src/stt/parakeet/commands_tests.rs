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
            "builder.run(",
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
        let inventory_size = parakeet_catalog::find(&model_id).unwrap().size_bytes
            + parakeet_catalog::VOCABULARY.size_bytes;
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
            serde_json::json!({"modelId":model_id,"requestId":request_id,"bufferId":buffer_id,
                "dictionary":["Voxloom","Kubernetes"]}),
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
fn actual_transcribe_command_joins_prepared_worker_and_returns_existing_dto() {
    let app = app();
    let main = window(&app, "main");
    let state = app.state::<SttState>();
    let model = "parakeet-tdt-0.6b-v3";
    state
        .parakeet
        .prepare(state.parakeet.epoch(), "ready", model, "v3", || {
            Ok(parakeet::model_dirs())
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
fn actual_transcribe_sends_the_dictionary_to_the_parakeet_worker() {
    // The fixture worker appends the words it received to its transcript.
    for (dictionary, text) in [
        (serde_json::json!([]), "[Music] Thank you."),
        (
            serde_json::json!([" Voxloom ", "voxloom", "", "Notion"]),
            "[Music] Thank you.: Voxloom, Notion",
        ),
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
                || Ok(parakeet::model_dirs()),
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
            serde_json::json!({"text":text,"rawText":text,"language":null,"dropped":null})
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
