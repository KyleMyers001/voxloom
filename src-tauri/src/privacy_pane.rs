//! Opens one allowlisted System Settings privacy pane so a user can fix the
//! grant a Home diagnostic names. It never prompts for or changes a permission.

// System Settings' Privacy & Security extension (macOS 13+; the app's minimum
// is 13.1). Needs a Mac check that it lands on the Accessibility list.
const ACCESSIBILITY: &str =
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility";

/// Map the frontend's pane id to a fixed URL; anything else is refused, so
/// the webview can never open an arbitrary URL through this command.
fn pane_url(pane: &str) -> Option<&'static str> {
    match pane {
        "accessibility" => Some(ACCESSIBILITY),
        _ => None,
    }
}

/// Async: spawning `open` must not block the UI thread.
#[tauri::command(async)]
pub fn privacy_pane_open(pane: String) -> Result<(), String> {
    let url = pane_url(&pane).ok_or_else(|| format!("Unknown privacy pane: {pane}"))?;
    open(url)
}

#[cfg(target_os = "macos")]
fn open(url: &str) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|error| format!("Could not open System Settings: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not open System Settings ({status})"))
    }
}

#[cfg(not(target_os = "macos"))]
fn open(_url: &str) -> Result<(), String> {
    Err("System Settings privacy panes exist only on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::pane_url;

    #[test]
    fn accessibility_maps_to_the_fixed_privacy_url() {
        assert_eq!(
            pane_url("accessibility"),
            Some("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility")
        );
    }

    #[test]
    fn unknown_or_url_like_panes_are_refused() {
        for pane in [
            "",
            "input-monitoring",
            "Privacy_Camera",
            "https://example.com",
            "accessibility;rm",
        ] {
            assert_eq!(pane_url(pane), None, "{pane}");
        }
    }
}
