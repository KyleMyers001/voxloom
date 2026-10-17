//! Failure evidence only; permission snapshots do not establish the tap's cause.

/// Which grant the failed tap most likely lacks, from non-prompting preflights.
/// Accessibility first: without it no check below is meaningful.
pub(super) fn failure_code(ax_trusted: bool, listen_access: bool) -> &'static str {
    if !ax_trusted {
        "cancel-ax-untrusted"
    } else if !listen_access {
        "cancel-listen-denied"
    } else {
        "cancel-tap-create-failed"
    }
}

pub(super) fn tap_failure_message(
    ax_trusted: bool,
    listen_access: bool,
    post_access: bool,
    app_id: &str,
    version: &str,
) -> super::ArmError {
    let code = failure_code(ax_trusted, listen_access);
    let detail = match code {
        "cancel-ax-untrusted" => "Accessibility trust is not granted to this process; check that the approved app matches this running copy",
        "cancel-listen-denied" => "macOS could not create the active Escape event tap; Accessibility is trusted but Input Monitoring is not granted to this running copy",
        _ => "macOS could not create the active Escape event tap despite Accessibility trust",
    };
    let message = format!(
        "Escape cancellation unavailable [{code}]. {detail}. Dictation continues \
         without Escape-cancel. Copy this error from Home for support. Permission checks are evidence, not a root-cause diagnosis. \
         (ax={ax_trusted} listen={listen_access} post={post_access}; \
         app={app_id} version={version} arch={} diagnostic=cancel-tap-v1)",
        std::env::consts::ARCH,
    );
    super::ArmError { code, message }
}

/// One stderr line per arm attempt; the full diagnostic stays on Home.
pub(super) fn arm_log_line(result: &Result<(), super::ArmError>) -> String {
    match result {
        Ok(()) => "[cancel] arm ok".into(),
        Err(error) => format!("[cancel] arm failed code={}", error.code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untrusted_tap_failure_reports_observed_permission_denial() {
        let error = tap_failure_message(false, false, false, "com.voxloom.test", "1.2.3");
        assert_eq!(error.code, "cancel-ax-untrusted");
        let message = error.message;
        assert!(message.contains("[cancel-ax-untrusted]"), "{message}");
        assert!(message.contains("Accessibility trust is not granted to this process"));
        assert!(message.contains("ax=false listen=false post=false"));
        assert!(message.contains("app=com.voxloom.test version=1.2.3"));
        assert!(message.contains("Dictation continues without Escape-cancel"));
        assert!(!message.contains("Capture was not started"));
        assert!(message.contains("not a root-cause diagnosis"));
    }

    #[test]
    fn trusted_tap_failure_never_claims_accessibility_is_missing() {
        for post in [false, true] {
            let error = tap_failure_message(true, true, post, "com.voxloom.test", "1.2.3");
            assert_eq!(error.code, "cancel-tap-create-failed");
            let message = error.message;
            assert!(message.contains("[cancel-tap-create-failed]"), "{message}");
            assert!(message.contains("macOS could not create the active Escape event tap"));
            assert!(!message.contains("Enable Voxloom Accessibility"));
            assert!(!message.contains("permission denied"));
            assert!(message.contains(&format!("ax=true listen=true post={post}")));
            assert!(message.contains("not a root-cause diagnosis"));
        }
    }

    #[test]
    fn trusted_without_listen_access_reports_input_monitoring() {
        for post in [false, true] {
            let error = tap_failure_message(true, false, post, "com.voxloom.test", "1.2.3");
            assert_eq!(error.code, "cancel-listen-denied");
            let message = error.message;
            assert!(message.contains("[cancel-listen-denied]"), "{message}");
            assert!(message.contains("Input Monitoring"), "{message}");
            assert!(message.contains(&format!("ax=true listen=false post={post}")));
            assert!(message.contains("not a root-cause diagnosis"));
        }
    }

    #[test]
    fn failure_code_prefers_accessibility_then_input_monitoring() {
        assert_eq!(failure_code(false, false), "cancel-ax-untrusted");
        assert_eq!(failure_code(false, true), "cancel-ax-untrusted");
        assert_eq!(failure_code(true, false), "cancel-listen-denied");
        assert_eq!(failure_code(true, true), "cancel-tap-create-failed");
    }

    #[test]
    fn arm_log_line_names_the_outcome_and_code() {
        assert_eq!(arm_log_line(&Ok(())), "[cancel] arm ok");
        let error = super::super::ArmError {
            code: "cancel-listen-denied",
            message: "full diagnostic".into(),
        };
        assert_eq!(
            arm_log_line(&Err(error)),
            "[cancel] arm failed code=cancel-listen-denied"
        );
    }
}
