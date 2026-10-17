//! Failure evidence only; permission snapshots do not establish the tap's cause.
//! The tap is active (it can swallow Escape), which macOS gates on
//! Accessibility, so only that grant picks the code. The Input Monitoring
//! (`listen=`) and posting (`post=`) preflights are copied as evidence only.

pub(super) fn tap_failure_message(
    ax_trusted: bool,
    listen_access: bool,
    post_access: bool,
    app_id: &str,
    version: &str,
) -> super::ArmError {
    let (code, detail) = if ax_trusted {
        (
            "cancel-tap-create-failed",
            "macOS could not create the active Escape event tap despite Accessibility trust",
        )
    } else {
        (
            "cancel-ax-untrusted",
            "Accessibility trust is not granted to this process; check that the approved app matches this running copy",
        )
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
    fn trusted_tap_failure_never_claims_a_missing_grant() {
        for listen in [false, true] {
            for post in [false, true] {
                let error = tap_failure_message(true, listen, post, "com.voxloom.test", "1.2.3");
                assert_eq!(error.code, "cancel-tap-create-failed");
                let message = error.message;
                assert!(message.contains("[cancel-tap-create-failed]"), "{message}");
                assert!(message.contains("macOS could not create the active Escape event tap"));
                assert!(!message.contains("Enable Voxloom Accessibility"));
                assert!(!message.contains("Input Monitoring"), "{message}");
                assert!(!message.contains("permission denied"));
                assert!(message.contains(&format!("ax=true listen={listen} post={post}")));
                assert!(message.contains("not a root-cause diagnosis"));
            }
        }
    }

    #[test]
    fn arm_log_line_names_the_outcome_and_code() {
        assert_eq!(arm_log_line(&Ok(())), "[cancel] arm ok");
        let error = super::super::ArmError {
            code: "cancel-ax-untrusted",
            message: "full diagnostic".into(),
        };
        assert_eq!(
            arm_log_line(&Err(error)),
            "[cancel] arm failed code=cancel-ax-untrusted"
        );
    }
}
