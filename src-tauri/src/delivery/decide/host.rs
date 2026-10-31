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

/// Info.plist keys only Electron/Chromium-embedding apps carry. Some Electron
/// apps rename the framework (ChatGPT for macOS, `com.openai.codex`, ships
/// `Codex Framework.framework`), but Electron still stamps these keys.
const ELECTRON_PLIST_KEYS: &[&str] = &["ElectronAsarIntegrity", "ChromiumBaseVersion"];

/// Info.plist files are a few KB; never read more than this.
pub const INFO_PLIST_MAX_BYTES: u64 = 256 * 1024;

/// `exe_path` is the target process's executable; `exists` checks a path and
/// `read` returns a file's bytes (both injected so this stays pure and testable).
pub fn unicode_typing_supported(
    exe_path: &str,
    exists: impl Fn(&str) -> bool,
    read: impl Fn(&str) -> Option<Vec<u8>>,
) -> bool {
    web_ax_activation(exe_path, exists, read).is_some()
}

/// True if the plist bytes name an Electron/Chromium key. Keys are ASCII, which
/// both XML plists and binary plists (ASCII string objects) store verbatim, so a
/// byte scan covers both formats without a plist parser.
fn plist_declares_electron(bytes: &[u8]) -> bool {
    ELECTRON_PLIST_KEYS
        .iter()
        .any(|key| bytes.windows(key.len()).any(|w| w == key.as_bytes()))
}

/// Capped read of a file for `read`; file I/O only, never touches the process.
pub fn read_small_file(path: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(INFO_PLIST_MAX_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}

/// Chromium handles AXEnhancedUserInterface; Electron explicitly exposes
/// AXManualAccessibility. Never probe unknown hosts or try alternate attributes:
/// Electron is identified from bundle files only (framework or Info.plist keys).
/// Sources: chrome/browser/chrome_browser_application_mac.mm and
/// electron/shell/browser/mac/electron_application.mm (upstream main).
pub fn web_ax_activation(
    exe_path: &str,
    exists: impl Fn(&str) -> bool,
    read: impl Fn(&str) -> Option<Vec<u8>>,
) -> Option<WebAxActivation> {
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
    )) || read(&format!("{bundle}/Contents/Info.plist"))
        .is_some_and(|bytes| plist_declares_electron(&bytes))
    {
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
    const NO_READ: fn(&str) -> Option<Vec<u8>> = |_| None;

    #[test]
    fn bootstrap_uses_host_specific_activation_and_preserves_allowlist() {
        for name in CHROMIUM_BROWSERS {
            let exe = format!("/Applications/{name}.app/Contents/MacOS/browser");
            let activation = web_ax_activation(&exe, NONE, NO_READ).unwrap();
            assert_eq!(activation.attribute(), "AXEnhancedUserInterface", "{name}");
        }
        let slack = "/Applications/Slack.app/Contents/MacOS/Slack";
        assert_eq!(
            web_ax_activation(
                slack,
                |p| {
                    p == "/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework"
                },
                NO_READ
            )
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
            assert_eq!(web_ax_activation(exe, NONE, NO_READ), None, "{exe}");
        }
    }

    #[test]
    fn chromium_browsers_are_supported() {
        for exe in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ] {
            assert!(unicode_typing_supported(exe, NONE, NO_READ), "{exe}");
        }
    }

    #[test]
    fn electron_apps_detected_by_framework() {
        let exe = "/Applications/Slack.app/Contents/MacOS/Slack";
        assert!(unicode_typing_supported(
            exe,
            |p| p == "/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework",
            NO_READ
        ));
        assert!(!unicode_typing_supported(exe, NONE, NO_READ));
    }

    /// Fresh fixture dir under the OS temp dir (no tempfile dev-dependency).
    fn fixture_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "voxloom-host-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Writes `<root>/<name>.app` with an executable stub and the given
    /// Info.plist; returns the executable path.
    fn fixture_bundle(root: &std::path::Path, name: &str, plist: &[u8]) -> String {
        let contents = root.join(format!("{name}.app/Contents"));
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        std::fs::create_dir_all(contents.join("Frameworks")).unwrap();
        std::fs::write(contents.join("Info.plist"), plist).unwrap();
        let exe = contents.join("MacOS").join(name);
        std::fs::write(&exe, b"").unwrap();
        exe.to_str().unwrap().to_owned()
    }

    fn real_exists(p: &str) -> bool {
        std::path::Path::new(p).exists()
    }

    const NATIVE_PLIST: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.example.native</string>
<key>CFBundleExecutable</key><string>Native</string>
</dict></plist>"#;

    #[test]
    fn electron_apps_detected_by_info_plist_keys() {
        let root = fixture_root("plist");
        // ChatGPT for macOS: renamed framework, Electron keys in Info.plist.
        std::fs::create_dir_all(
            root.join("ChatGPT.app/Contents/Frameworks/Codex Framework.framework"),
        )
        .unwrap();
        let codex = fixture_bundle(
            &root,
            "ChatGPT",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.openai.codex</string>
<key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict>
<key>algorithm</key><string>SHA256</string></dict></dict>
</dict></plist>"#,
        );
        assert_eq!(
            web_ax_activation(&codex, real_exists, read_small_file),
            Some(WebAxActivation::Electron)
        );
        assert!(unicode_typing_supported(
            &codex,
            real_exists,
            read_small_file
        ));

        // Binary plists store ASCII keys verbatim; this is a minimal bplist fragment
        // with the key as an ASCII string object (0x5F, int length 0x13).
        let mut bplist = b"bplist00\xd1\x01\x02".to_vec();
        bplist.push(0x5f);
        bplist.extend_from_slice(b"\x10\x13ChromiumBaseVersion");
        let chromium = fixture_bundle(&root, "BinaryElectron", &bplist);
        assert_eq!(
            web_ax_activation(&chromium, real_exists, read_small_file),
            Some(WebAxActivation::Electron)
        );

        // Plain native bundle: real Info.plist, no Electron keys or framework.
        let native = fixture_bundle(&root, "Native", NATIVE_PLIST);
        assert_eq!(
            web_ax_activation(&native, real_exists, read_small_file),
            None
        );
        assert!(!unicode_typing_supported(
            &native,
            real_exists,
            read_small_file
        ));

        // The Electron Framework check still works without any Info.plist hit.
        let slack = fixture_bundle(&root, "Slack", NATIVE_PLIST);
        std::fs::create_dir_all(
            root.join("Slack.app/Contents/Frameworks/Electron Framework.framework"),
        )
        .unwrap();
        assert_eq!(
            web_ax_activation(&slack, real_exists, read_small_file),
            Some(WebAxActivation::Electron)
        );

        // Missing Info.plist and non-bundle paths are never Electron.
        std::fs::remove_file(root.join("ChatGPT.app/Contents/Info.plist")).unwrap();
        assert_eq!(
            web_ax_activation(&codex, real_exists, read_small_file),
            None
        );
        assert_eq!(
            web_ax_activation("/usr/bin/unknown", real_exists, read_small_file),
            None
        );

        let _ = std::fs::remove_dir_all(&root);
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
            assert!(!unicode_typing_supported(exe, NONE, NO_READ), "{exe}");
        }
        // Helper processes resolve to the outer browser bundle.
        assert_eq!(
            app_bundle_root("/Applications/Google Chrome.app/Contents/Frameworks/x.app/y"),
            Some("/Applications/Google Chrome.app")
        );
    }
}
