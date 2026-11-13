//! BUS-223: native fields that AX refuses (Word, Excel, Mail, Journal, ...).
//! Pure decisions for the guarded ⌘V fallback:
//! - `ValueStatus`: an empty field (kAXErrorNoValue, nil, "") or an
//!   attributed AXValue is readable; any other AX error is not;
//! - `classify_target`: roles outside the AX allowlist become paste-only
//!   targets when they look editable, never a grid/table selection;
//! - `may_paste`: the ⌘V fallback runs only after nothing was written.

use super::diag::DeliveryDiag;
use super::report::{InsertReport, PasteReport};
use super::retry::{RETRY_READBACK_POLLS, RETRY_READBACK_POLL_MS};
use super::target::{classify_role, effective_role};
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
/// (no value before and after) proves nothing after a write AX accepted: the
/// text may have landed unseen, so it reads as unknown (no paste, no
/// double insert). After an AX error the empty value stands.
pub fn readback_text(write_ok: bool, before: &ValueStatus, after: &ValueStatus) -> Option<String> {
    if write_ok && *before == ValueStatus::NoValue && *after == ValueStatus::NoValue {
        return None;
    }
    after.text().map(str::to_string)
}

/// Poll the read-back (BUS-223 b): apps may apply AXSelectedText
/// asynchronously. Up to `RETRY_READBACK_POLLS` reads `RETRY_READBACK_POLL_MS`
/// apart (~600 ms, as the retry path), only while the field still reads
/// exactly as `before`. The first read that differs (proof, a partial or
/// other change, or an unknown value) is latched and returned at once, so a
/// later revert can never turn a change back into "unchanged" (and a paste).
/// The verification itself stays strict.
pub fn poll_readback(
    write_ok: bool,
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
        last = readback_text(write_ok, before, &read());
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
/// edit mode is an allowlisted text role and passes, even inside a grid.
pub fn is_grid_selection<S: AsRef<str>>(role: &str, ancestors: &[S]) -> bool {
    if GRID_ROLES.contains(&role) {
        return true;
    }
    classify_role(role).0 != "insertable"
        && ancestors.iter().any(|r| GRID_ROLES.contains(&r.as_ref()))
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

/// Whether the ⌘V fallback may run after the AX path wrote nothing (an
/// `Err` from it). Err gives why not, for the log; the caller then copies.
/// `apple_terminal` / `known_terminal`: terminals have their own routes, and
/// a newline pasted there could run a command.
pub fn may_paste(
    validated: &TargetSnapshotDto,
    enabled: bool,
    apple_terminal: Option<bool>,
    known_terminal: bool,
) -> Result<i32, &'static str> {
    if !enabled {
        return Err("clipboard fallback off");
    }
    if !validated.insertable || validated.kind != "insertable" {
        return Err("target not insertable");
    }
    if apple_terminal != Some(false) || known_terminal {
        return Err("terminal or unknown executable");
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
