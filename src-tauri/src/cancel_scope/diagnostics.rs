//! Failure evidence only; permission snapshots do not establish the tap's cause.

pub(super) fn tap_failure_message(
    ax_trusted: bool,
    listen_access: bool,
    post_access: bool,
    app_id: &str,
    version: &str,
) -> String {
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
    format!(
        "Escape cancellation unavailable [{code}]. {detail}. Capture was not started. \
         Copy this error from Home for support. Permission checks are evidence, not a root-cause diagnosis. \
         (ax={ax_trusted} listen={listen_access} post={post_access}; \
         app={app_id} version={version} arch={} diagnostic=cancel-tap-v1)",
        std::env::consts::ARCH,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untrusted_tap_failure_reports_observed_permission_denial() {
        let message = tap_failure_message(false, false, false, "com.voxloom.test", "1.2.3");
        assert!(message.contains("[cancel-ax-untrusted]"), "{message}");
        assert!(message.contains("Accessibility trust is not granted to this process"));
        assert!(message.contains("ax=false listen=false post=false"));
        assert!(message.contains("app=com.voxloom.test version=1.2.3"));
        assert!(message.contains("Capture was not started"));
        assert!(message.contains("not a root-cause diagnosis"));
    }

    #[test]
    fn trusted_tap_failure_never_claims_accessibility_is_missing() {
        for listen in [false, true] {
            for post in [false, true] {
                let message = tap_failure_message(true, listen, post, "com.voxloom.test", "1.2.3");
                assert!(message.contains("[cancel-tap-create-failed]"), "{message}");
                assert!(message.contains("macOS could not create the active Escape event tap"));
                assert!(!message.contains("Enable Voxloom Accessibility"));
                assert!(!message.contains("permission denied"));
                assert!(message.contains(&format!("ax=true listen={listen} post={post}")));
                assert!(message.contains("not a root-cause diagnosis"));
            }
        }
    }
}
