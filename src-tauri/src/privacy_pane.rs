//! Opens one allowlisted System Settings privacy pane so a user can fix the
//! grant a Home diagnostic names. It never prompts for or changes a permission.

const SECURITY: &str = "x-apple.systempreferences:com.apple.preference.security";

/// Map the frontend's pane id to a fixed URL; anything else is refused, so
/// the webview can never open an arbitrary URL through this command.
fn pane_url(pane: &str) -> Option<String> {
    let anchor = match pane {
        "accessibility" => "Privacy_Accessibility",
        "input-monitoring" => "Privacy_ListenEvent",
        _ => return None,
    };
    Some(format!("{SECURITY}?{anchor}"))
}

#[tauri::command]
pub fn privacy_pane_open(pane: String) -> Result<(), String> {
    let url = pane_url(&pane).ok_or_else(|| format!("Unknown privacy pane: {pane}"))?;
    open(&url)
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
    fn known_panes_map_to_fixed_privacy_urls() {
        assert_eq!(
            pane_url("accessibility").as_deref(),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        );
        assert_eq!(
            pane_url("input-monitoring").as_deref(),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        );
    }

    #[test]
    fn unknown_or_url_like_panes_are_refused() {
        for pane in [
            "",
            "Privacy_Camera",
            "https://example.com",
            "accessibility;rm",
        ] {
            assert_eq!(pane_url(pane), None, "{pane}");
        }
    }
}
