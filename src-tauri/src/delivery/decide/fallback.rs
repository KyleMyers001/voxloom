//! BUS-223: native fields that AX refuses (Word, Excel, Mail, Journal, ...).
//! Pure decisions for the guarded ⌘V fallback:
//! - `ValueStatus`: an empty field (kAXErrorNoValue, nil, "") or an
//!   attributed AXValue is readable; any other AX error is not;
//! - `classify_target`: roles outside the AX allowlist become paste-only
//!   targets when they look editable, never a grid/table selection;
//! - `may_paste`: the ⌘V fallback runs only after nothing was written
//!   (Ok writes proven unchanged, or write-free AX errors only).

use super::diag::DeliveryDiag;
use super::report::{InsertReport, PasteReport};
use super::retry::{RETRY_READBACK_POLLS, RETRY_READBACK_POLL_MS};
use super::target::{classify_role, effective_role};
use super::text::check_typing_text;
use super::verify::same_ax_text;
use crate::delivery::types::TargetSnapshotDto;

/// kAXErrorNoValue: the attribute exists but has no value (an empty field).
pub const AX_ERROR_NO_VALUE: i32 = -25212;
/// `ax::copy_attr`'s code for a successful copy that returned nil.
pub const AX_NIL_VALUE: i32 = -1;

/// What the field's AXValue read gave. Never logged with its contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValueStatus {
    /// A CFString, or the plain string of a CFAttributedString.
    Text(String),
    /// kAXErrorNoValue or nil: an empty field, read as "".
    NoValue,
    /// Any other AX error, or a value that is not text.
    Unreadable(Option<i32>),
}

impl ValueStatus {
    /// `read`: Ok(Some) text, Ok(None) a non-text value, Err an AX error.
    pub fn from_read(read: Result<Option<String>, i32>) -> Self {
        match read {
            Ok(Some(text)) => Self::Text(text),
            Ok(None) => Self::Unreadable(None),
            Err(AX_ERROR_NO_VALUE | AX_NIL_VALUE) => Self::NoValue,
            Err(code) => Self::Unreadable(Some(code)),
        }
    }

    /// The value to verify against; None when it cannot be read.
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::NoValue => Some(""),
            Self::Unreadable(_) => None,
        }
    }

    /// For the diagnostic log: the kind of value, never its contents.
    pub fn label(&self) -> String {
        match self {
            Self::Text(text) if text.is_empty() => "empty".into(),
            Self::Text(_) => "text".into(),
            Self::NoValue => "no-value".into(),
            Self::Unreadable(Some(code)) => format!("unreadable({code})"),
            Self::Unreadable(None) => "unreadable(not text)".into(),
        }
    }
}

/// Read-back evidence after the AX write. A field that never exposed a value
/// (no value before and after) proves nothing, whatever the write returned:
/// the text may have landed unseen (an AX error does not prove it did not),
/// so it reads as unknown (no paste, no double insert).
pub fn readback_text(before: &ValueStatus, after: &ValueStatus) -> Option<String> {
    if *before == ValueStatus::NoValue && *after == ValueStatus::NoValue {
        return None;
    }
    after.text().map(str::to_string)
}

/// AX errors returned before the app touched the field: unsupported
/// attribute, illegal argument, not implemented, API disabled, invalid
/// element. Any other error (-25204 CannotComplete, -25200 Failure, ...) may
/// come back after the text landed (a busy app), so it never pastes.
pub const WRITE_FREE_AX_ERRORS: &[i32] = &[-25205, -25201, -25208, -25211, -25202];

/// Every AXSelectedText write the AX path made (first and Chromium retry):
/// Ok, or its AX error code. Empty when AX refused before any write.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AxAttempt {
    pub writes: Vec<Result<(), i32>>,
    /// The web-field Unicode typing route (`AfterAx::TypeFallback`) ran.
    pub typed: bool,
}

impl AxAttempt {
    /// No write can have landed unseen: each one returned Ok (read-back then
    /// proved the field unchanged) or a write-free error.
    pub fn write_free(&self) -> bool {
        self.writes.iter().all(|write| match write {
            Ok(()) => true,
            Err(code) => WRITE_FREE_AX_ERRORS.contains(code),
        })
    }
}

/// Web content: the web area itself, a DOM-backed element, or anything
/// under an AXWebArea. Unlike `is_web_content_field`, any role counts.
pub fn in_web_content<S: AsRef<str>>(role: &str, has_dom_id: bool, ancestors: &[S]) -> bool {
    role == "AXWebArea" || has_dom_id || ancestors.iter().any(|r| r.as_ref() == "AXWebArea")
}

/// The field right before the ⌘V reads exactly as it did before the AX path
/// (both unreadable only on a refusal before any write).
pub fn field_unchanged(before: &ValueStatus, now: &ValueStatus) -> bool {
    match (before.text(), now.text()) {
        (Some(was), Some(is)) => same_ax_text(was, is),
        (None, None) => true,
        _ => false,
    }
}

/// Poll the read-back (BUS-223 b): apps may apply AXSelectedText
/// asynchronously. Up to `RETRY_READBACK_POLLS` reads `RETRY_READBACK_POLL_MS`
/// apart (~600 ms, as the retry path), only while the field still reads
/// exactly as `before`. The first read that differs (proof, a partial or
/// other change, or an unknown value) is latched and returned at once, so a
/// later revert can never turn a change back into "unchanged" (and a paste).
/// The verification itself stays strict.
pub fn poll_readback(
    before: &ValueStatus,
    mut read: impl FnMut() -> ValueStatus,
    mut sleep: impl FnMut(u64),
) -> Option<String> {
    let before_text = before.text();
    let mut last = None;
    for poll in 0..RETRY_READBACK_POLLS {
        if poll > 0 {
            sleep(RETRY_READBACK_POLL_MS);
        }
        last = readback_text(before, &read());
        let unchanged = matches!(
            (last.as_deref(), before_text),
            (Some(now), Some(was)) if same_ax_text(now, was)
        );
        if !unchanged {
            return last;
        }
    }
    last
}

/// Settable edit attributes of the focused element.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EditFacts {
    pub value: bool,
    pub selected_text: bool,
    pub selected_range: bool,
}

impl EditFacts {
    pub fn any(&self) -> bool {
        self.value || self.selected_text || self.selected_range
    }

    pub fn label(&self) -> String {
        let flag = |on: bool| if on { 1 } else { 0 };
        format!(
            "value={} selected_text={} range={}",
            flag(self.value),
            flag(self.selected_text),
            flag(self.selected_range)
        )
    }
}

/// Spreadsheet grids and tables: a ⌘V into a selected cell (not in edit
/// mode) replaces it, so these stay Copy.
const GRID_ROLES: &[&str] = &[
    "AXTable",
    "AXGrid",
    "AXCell",
    "AXLayoutArea",
    "AXLayoutItem",
    "AXOutline",
    "AXRow",
    "AXColumn",
    "AXList",
    "AXBrowser",
];

/// Controls that are never edited by pasting.
const CONTROL_ROLES: &[&str] = &[
    "AXStaticText",
    "AXButton",
    "AXImage",
    "AXToolbar",
    "AXMenu",
    "AXMenuItem",
    "AXCheckBox",
    "AXRadioButton",
    "AXPopUpButton",
    "AXSlider",
];

/// A grid/table selection without editable text focus. A cell editor in
/// edit mode is an allowlisted text role and stays an AX target, even inside
/// a grid; `may_paste` still refuses its ⌘V (`under_grid`).
pub fn is_grid_selection<S: AsRef<str>>(role: &str, ancestors: &[S]) -> bool {
    if GRID_ROLES.contains(&role) {
        return true;
    }
    classify_role(role).0 != "insertable"
        && ancestors.iter().any(|r| GRID_ROLES.contains(&r.as_ref()))
}

/// Ancestors that make any focused element, allowlisted text roles included,
/// a grid/table context for the ⌘V gate. A selected (not editing) cell may
/// expose a text role with a settable range, the same AX facts as the cell
/// editor in edit mode, so the two cannot be told apart from here: the safe
/// side is no paste (the AX write itself still runs and verifies).
const GRID_ANCESTORS: &[&str] = &["AXTable", "AXGrid", "AXOutline", "AXCell", "AXRow"];

pub fn under_grid<S: AsRef<str>>(ancestors: &[S]) -> bool {
    ancestors
        .iter()
        .any(|r| GRID_ANCESTORS.contains(&r.as_ref()))
}

pub const GRID_REASON: &str =
    "spreadsheet grid or table selection (no cell in edit mode) — insert skipped";

/// `classify_role`, plus paste-only targets: a container or unknown role
/// whose edit attributes are settable is insertable, but only through the
/// ⌘V fallback (`choose_insert_path` never AX-writes it). `facts` and
/// `ancestors` are only read for such roles.
pub fn classify_target(
    role: &str,
    subrole: Option<&str>,
    facts: impl FnOnce() -> EditFacts,
    ancestors: impl FnOnce() -> Vec<String>,
) -> (&'static str, bool, Option<&'static str>) {
    let base = classify_role(effective_role(role, subrole));
    // "unknown": the AXRole itself could not be read (`build_snapshot`).
    if base.0 != "unsupported" || role == "unknown" || CONTROL_ROLES.contains(&role) {
        return base;
    }
    if GRID_ROLES.contains(&role) {
        return ("unsupported", false, Some(GRID_REASON));
    }
    if !facts().any() {
        return base;
    }
    if is_grid_selection(role, &ancestors()) {
        return ("unsupported", false, Some(GRID_REASON));
    }
    ("insertable", true, None)
}

/// What the ⌘V gate knows after the AX path returned `Err`.
#[derive(Debug, Default)]
pub struct PasteFacts {
    /// The Clipboard fallback setting.
    pub enabled: bool,
    /// `host::apple_terminal_identity`; None when unknown.
    pub apple_terminal: Option<bool>,
    pub known_terminal: bool,
    pub attempt: AxAttempt,
    /// A Chromium/Electron host (`host::web_ax_activation`).
    pub web_host: bool,
    /// `in_web_content` for the focused element.
    pub web_content: bool,
    /// `under_grid` for the focused element's ancestors.
    pub grid_ancestor: bool,
    /// `field_unchanged(before the AX path, right before the paste)`.
    pub field_unchanged: bool,
}

/// Whether the ⌘V fallback may run after the AX path wrote nothing (an
/// `Err` from it). Err gives why not, for the log; the caller then copies.
/// Terminals have their own routes, and a newline pasted there could run a
/// command. So could one in web content: xterm.js terminals (VS Code, Cursor,
/// Hyper, Tabby, Wave, browser shells) are web fields. A Chromium/Electron
/// web field keeps its own typing route and never pastes; any other web
/// host or web content pastes single-line text only (`check_typing_text`).
pub fn may_paste(
    validated: &TargetSnapshotDto,
    facts: &PasteFacts,
    text: &str,
) -> Result<i32, &'static str> {
    if !facts.enabled {
        return Err("clipboard fallback off");
    }
    if !validated.insertable || validated.kind != "insertable" {
        return Err("target not insertable");
    }
    if facts.apple_terminal != Some(false) || facts.known_terminal {
        return Err("terminal or unknown executable");
    }
    if facts.grid_ancestor {
        return Err("grid or table ancestor");
    }
    if !facts.attempt.write_free() {
        return Err("AX error may have applied the write");
    }
    if !facts.field_unchanged {
        return Err("field changed since the AX attempt");
    }
    if facts.attempt.typed || (facts.web_host && facts.web_content) {
        return Err("Chromium/Electron web field");
    }
    if (facts.web_host || facts.web_content) && check_typing_text(text).is_err() {
        return Err("multi-line or control text in web content");
    }
    validated.app_pid.ok_or("no target pid")
}

/// Run the ⌘V fallback after the AX path. Only an `Err` from it (nothing
/// written: refused before the write, or read-back proved the field
/// unchanged) may paste; any `Ok`, including a partial or unverified write,
/// is returned as is, so text is never inserted twice. `gate` is
/// `may_paste`'s answer; `paste` posts one guarded ⌘V into that pid;
/// `confirmed` reads the field back after it.
pub fn after_ax_refusal(
    ax: Result<InsertReport, String>,
    gate: Result<i32, &'static str>,
    paste: impl FnOnce(i32) -> Result<PasteReport, String>,
    confirmed: impl FnOnce() -> bool,
    diag: &mut DeliveryDiag,
) -> Result<InsertReport, String> {
    let reason = match ax {
        Ok(report) => return Ok(report),
        Err(reason) => reason,
    };
    diag.reason = Some(reason.clone());
    let pid = match gate {
        Ok(pid) => pid,
        Err(why) => {
            diag.fallback = format!("skipped({why})");
            return Err(reason);
        }
    };
    let report = match paste(pid) {
        Ok(report) => report,
        Err(error) => {
            diag.fallback = "paste-refused".into();
            return Err(format!("{reason}; ⌘V fallback skipped: {error}"));
        }
    };
    let verified = confirmed();
    diag.fallback = if verified {
        "paste-confirmed"
    } else {
        "paste-unverified"
    }
    .into();
    let detail = if verified {
        format!("pasted with ⌘V after AX refused ({reason})")
    } else {
        format!("pasted with ⌘V after AX refused ({reason}); read-back could not confirm it")
    };
    Ok(InsertReport {
        unverified: !verified,
        detail: Some(detail),
        paste: Some(report),
        ..Default::default()
    })
}

#[cfg(test)]
#[path = "fallback_tests.rs"]
mod tests;
