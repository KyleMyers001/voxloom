//! BUS-43: session-scoped Escape ownership and native delivery barrier.
//! Sync IPC and window callbacks run on the UI thread, as does the event tap.

#[cfg(any(target_os = "macos", test))]
mod diagnostics;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
mod tests;

/// Structured arm failure; the frontend branches on `code`, never on text.
#[derive(Debug, serde::Serialize)]
pub struct ArmError {
    pub code: &'static str,
    pub message: String,
}

#[cfg(target_os = "macos")]
impl From<String> for ArmError {
    fn from(message: String) -> Self {
        Self {
            code: "cancel-arm-failed",
            message,
        }
    }
}

// The scope state machine only runs behind the macOS event tap.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
enum Action {
    Pass,
    Cancel,
    CancelAndSwallow,
}

#[cfg(any(target_os = "macos", test))]
struct ScopeState {
    session: String,
    visible: bool,
    cancelled: bool,
}

#[cfg(any(target_os = "macos", test))]
impl ScopeState {
    fn new(session: String) -> Self {
        Self {
            session,
            visible: false,
            cancelled: false,
        }
    }

    fn event(&mut self, event: u32, key: i64) -> Action {
        if self.cancelled {
            return Action::Pass;
        }
        // A disabled tap cannot uphold the cancellation guarantee. Fail closed
        // even before the popup is shown; do not re-enable a revoked monitor.
        let action = if event == u32::MAX || event == u32::MAX - 1 {
            Action::Cancel
        } else if self.visible && event == 10 && key == 53 {
            Action::CancelAndSwallow
        } else {
            return Action::Pass;
        };
        self.cancelled = true;
        self.visible = false;
        action
    }

    fn can_finish(&self, session: &str) -> bool {
        self.session == session && !self.cancelled
    }
}

#[tauri::command]
pub fn dictation_cancel_arm(app: tauri::AppHandle, session: String) -> Result<(), ArmError> {
    #[cfg(target_os = "macos")]
    {
        let result = macos::arm(app, session);
        eprintln!("{}", diagnostics::arm_log_line(&result));
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session);
        Ok(())
    }
}

#[tauri::command]
pub fn dictation_cancel_finish(app: tauri::AppHandle, session: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    return macos::finish(&app, &session);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session);
        Ok(true)
    }
}

#[tauri::command]
pub fn dictation_cancel_end(app: tauri::AppHandle, session: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::end(&app, &session)?;
    }
    let _ = (app, session);
    Ok(())
}

pub fn can_show() -> bool {
    #[cfg(target_os = "macos")]
    return macos::can_show();
    #[cfg(not(target_os = "macos"))]
    true
}

pub fn visible(value: bool) {
    #[cfg(target_os = "macos")]
    macos::visible(value);
    let _ = value;
}

pub fn close() {
    #[cfg(target_os = "macos")]
    macos::close();
}
