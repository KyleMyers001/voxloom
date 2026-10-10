//! Which apps may receive the Unicode key-event fallback.
//!
//! Apple documents that frameworks may ignore CGEventKeyboardSetUnicodeString
//! and translate the carrier keycode instead, which would type the carrier's
//! character. Chromium (browsers and Electron) honors the Unicode string, so
//! typing is restricted to those hosts; everything else falls back to Copy.

/// Chromium-based browser bundle names (lowercase, without `.app`).
const CHROMIUM_BROWSERS: &[&str] = &[
    "google chrome",
    "google chrome beta",
    "google chrome dev",
    "google chrome canary",
    "chromium",
    "brave browser",
    "brave browser beta",
    "brave browser nightly",
    "microsoft edge",
    "vivaldi",
    "opera",
    "arc",
];

/// Outermost `.app` bundle path of an executable path, if any.
pub fn app_bundle_root(exe_path: &str) -> Option<&str> {
    let end = exe_path.find(".app/")? + ".app".len();
    Some(&exe_path[..end])
}

/// `exe_path` is the target process's executable; `exists` checks a path
/// (injected so this stays pure and testable).
pub fn unicode_typing_supported(exe_path: &str, exists: impl Fn(&str) -> bool) -> bool {
    web_ax_activation(exe_path, exists).is_some()
}

/// Chromium handles AXEnhancedUserInterface; Electron explicitly exposes
/// AXManualAccessibility. Never probe unknown hosts or try alternate attributes.
/// Sources: chrome/browser/chrome_browser_application_mac.mm and
/// electron/shell/browser/mac/electron_application.mm (upstream main).
pub fn web_ax_activation(exe_path: &str, exists: impl Fn(&str) -> bool) -> Option<WebAxActivation> {
    let bundle = app_bundle_root(exe_path)?;
    let name = bundle
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim_end_matches(".app")
        .to_lowercase();
    if CHROMIUM_BROWSERS.contains(&name.as_str()) {
        Some(WebAxActivation::Chromium)
    } else if exists(&format!(
        "{bundle}/Contents/Frameworks/Electron Framework.framework"
    )) {
        Some(WebAxActivation::Electron)
    } else {
        None
    }
}

/// Only these fixed activation attributes can reach AX.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebAxActivation {
    Chromium,
    Electron,
}

impl WebAxActivation {
    pub fn attribute(self) -> &'static str {
        match self {
            Self::Chromium => "AXEnhancedUserInterface",
            Self::Electron => "AXManualAccessibility",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: fn(&str) -> bool = |_| false;

    #[test]
    fn bootstrap_uses_host_specific_activation_and_preserves_allowlist() {
        for name in CHROMIUM_BROWSERS {
            let exe = format!("/Applications/{name}.app/Contents/MacOS/browser");
            let activation = web_ax_activation(&exe, NONE).unwrap();
            assert_eq!(activation.attribute(), "AXEnhancedUserInterface", "{name}");
        }
        let slack = "/Applications/Slack.app/Contents/MacOS/Slack";
        assert_eq!(
            web_ax_activation(slack, |p| {
                p == "/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework"
            })
            .unwrap()
            .attribute(),
            "AXManualAccessibility"
        );
        for exe in [
            slack,
            "/Applications/Safari.app/Contents/MacOS/Safari",
            "/usr/bin/unknown",
            "",
        ] {
            assert_eq!(web_ax_activation(exe, NONE), None, "{exe}");
        }
    }

    #[test]
    fn chromium_browsers_are_supported() {
        for exe in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ] {
            assert!(unicode_typing_supported(exe, NONE), "{exe}");
        }
    }

    #[test]
    fn electron_apps_detected_by_framework() {
        let exe = "/Applications/Slack.app/Contents/MacOS/Slack";
        assert!(unicode_typing_supported(exe, |p| {
            p == "/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework"
        }));
        assert!(!unicode_typing_supported(exe, NONE));
    }

    #[test]
    fn other_hosts_never_type() {
        for exe in [
            "/Applications/Safari.app/Contents/MacOS/Safari",
            "/System/Applications/Notes.app/Contents/MacOS/Notes",
            "/Applications/Firefox.app/Contents/MacOS/firefox",
            "/usr/local/bin/some-cli",
            "",
        ] {
            assert!(!unicode_typing_supported(exe, NONE), "{exe}");
        }
        // Helper processes resolve to the outer browser bundle.
        assert_eq!(
            app_bundle_root("/Applications/Google Chrome.app/Contents/Frameworks/x.app/y"),
            Some("/Applications/Google Chrome.app")
        );
    }
}
