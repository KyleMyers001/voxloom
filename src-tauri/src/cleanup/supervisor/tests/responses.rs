//! Worker reply validation and readiness checks.

use super::*;

#[test]
fn worker_response_shapes_ids_and_diagnostics_are_bounded() {
    let cases = [
        (
            "empty-success",
            "ok",
            "",
            "None",
            "None",
            "'text'",
            "runtime-error",
        ),
        (
            "wrong-error",
            "error",
            "other",
            "'context-overflow'",
            "'full'",
            "None",
            "runtime-error",
        ),
        (
            "unknown-status",
            "future",
            "r",
            "'context-overflow'",
            "'full'",
            "None",
            "runtime-error",
        ),
        (
            "mixed-error",
            "error",
            "r",
            "'context-overflow'",
            "'full'",
            "'text'",
            "runtime-error",
        ),
        (
            "long-error",
            "error",
            "r",
            "'context-overflow'",
            "'é' * 513",
            "None",
            "runtime-error",
        ),
        (
            "long-code",
            "error",
            "r",
            "'x' * 65",
            "'full'",
            "None",
            "runtime-error",
        ),
        (
            "unknown-code",
            "error",
            "",
            "'future-code'",
            "'diagnostic'",
            "None",
            "runtime-error",
        ),
        (
            "invalid-output",
            "error",
            "r",
            "'invalid-output'",
            "'invalid UTF-8'",
            "None",
            "invalid-output",
        ),
        (
            // BUS-16 3c-2c: the worker's own time cap.
            "worker-timeout",
            "error",
            "r",
            "'timeout'",
            "'cleanup ran out of time'",
            "None",
            "timeout",
        ),
        (
            "long-output",
            "ok",
            "r",
            "None",
            "None",
            "'é' * 16001",
            "invalid-output",
        ),
    ];
    for (name, status, id, code, message, text, expected) in cases {
        let path = fake_worker(
            name,
            &format!(
                r#"{FRAMING}
read()
write({{"error": {message}, "errorCode": {code}, "requestId": "{id}",
       "status": "{status}", "text": {text}}})
"#
            ),
        );
        let supervisor = WorkerSupervisor::new(path);
        let error = supervisor
            .run(&model_file(name), "p".into(), "r".into())
            .unwrap_err();
        assert_eq!(error.code, expected, "{name}");
        assert!(error.message.len() <= 1024, "{name}");
        if name == "unknown-code" {
            assert_eq!(error.message, "diagnostic");
        }
    }
}

#[test]
fn readiness_requires_an_executable_regular_file() {
    let path = fake_worker("readiness", "raise RuntimeError('must not run')");
    let supervisor = WorkerSupervisor::new(path.clone());
    assert!(supervisor.available());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(!supervisor.available());
    assert!(!WorkerSupervisor::new(fake_root("readiness")).available());
    let error = supervisor
        .run(&model_file("not-executable"), "p".into(), "r".into())
        .unwrap_err();
    // Its own reason, so History says "cleanup unavailable" (BUS-135).
    assert_eq!(error.code, "worker-missing");
    assert!(error.message.contains("not executable"));
}

#[test]
fn unavailable_worker_fails_honestly() {
    let supervisor = WorkerSupervisor::new(PathBuf::from("/missing"));
    let error = supervisor
        .run(&model_file("missing"), "prompt".into(), "r1".into())
        .unwrap_err();
    assert_eq!(error.code, "worker-missing");
    assert!(error.message.contains("not installed"));
}
