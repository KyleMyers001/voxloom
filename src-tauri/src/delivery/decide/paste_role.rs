//! BUS-223: which focused roles outside the AX insert allowlist are
//! paste-only targets (insertable only through the ⌘V fallback;
//! `choose_insert_path` never AX-writes them). An explicit allowlist that
//! needs caret evidence, never a denylist: a settable AXValue alone also
//! marks sliders, steppers, date pickers and other controls.

use super::target::{classify_role, effective_role};

/// Edit attributes of the focused element.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EditFacts {
    /// AXValue settable.
    pub value: bool,
    /// AXSelectedText settable.
    pub selected_text: bool,
    /// AXSelectedTextRange settable.
    pub selected_range: bool,
    /// AXValue reads as text (`ValueStatus::text`).
    pub text_value: bool,
}

impl EditFacts {
    /// Real caret evidence: the selection itself can be set.
    pub fn caret(&self) -> bool {
        self.selected_text || self.selected_range
    }

    pub fn label(&self) -> String {
        let flag = |on: bool| if on { 1 } else { 0 };
        format!(
            "value={} selected_text={} range={} text={}",
            flag(self.value),
            flag(self.selected_text),
            flag(self.selected_range),
            flag(self.text_value)
        )
    }
}

/// Containers that hold a document's caret (Word/Pages body, WebKit
/// compose, web editors): paste-only with caret evidence.
const PASTE_ONLY_CONTAINERS: &[&str] = &["AXWebArea", "AXGroup", "AXScrollArea", "AXDocument"];

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

/// Standard roles never edited by pasting, whatever they report settable.
/// Any role not listed here, in `GRID_ROLES` or in `PASTE_ONLY_CONTAINERS`
/// is an unknown custom role.
const NEVER_PASTE_ROLES: &[&str] = &[
    // Code review list (CR round 1).
    "AXScrollBar",
    "AXIncrementor",
    "AXDisclosureTriangle",
    "AXSplitter",
    "AXColorWell",
    "AXDateField",
    "AXTimeField",
    "AXValueIndicator",
    "AXLevelIndicator",
    "AXRadioGroup",
    "AXTabGroup",
    "AXMenuButton",
    "AXLink",
    "AXSlider",
    "AXPopUpButton",
    "AXCheckBox",
    "AXButton",
    "AXList",
    "AXTable",
    "AXOutline",
    "AXRow",
    "AXCell",
    // Other standard non-text roles.
    "AXStaticText",
    "AXImage",
    "AXToolbar",
    "AXMenu",
    "AXMenuBar",
    "AXMenuBarItem",
    "AXMenuItem",
    "AXRadioButton",
    "AXProgressIndicator",
    "AXBusyIndicator",
    "AXRelevanceIndicator",
    "AXHandle",
    "AXRuler",
    "AXRulerMarker",
    "AXGrowArea",
    "AXMatte",
    "AXHelpTag",
    "AXDockItem",
    "AXHeading",
    "AXPopover",
    "AXSplitGroup",
    "AXSheet",
    "AXDrawer",
    "AXWindow",
    "AXApplication",
    "AXSystemWide",
];

/// A grid/table selection without editable text focus. A cell editor in
/// edit mode is an allowlisted text role and stays an AX target, even inside
/// a grid; `may_paste` still refuses its ⌘V (`fallback::under_grid`).
pub fn is_grid_selection<S: AsRef<str>>(role: &str, ancestors: &[S]) -> bool {
    if GRID_ROLES.contains(&role) {
        return true;
    }
    classify_role(role).0 != "insertable"
        && ancestors.iter().any(|r| GRID_ROLES.contains(&r.as_ref()))
}

pub const GRID_REASON: &str =
    "spreadsheet grid or table selection (no cell in edit mode) — insert skipped";

/// `classify_role`, plus paste-only targets: one of `PASTE_ONLY_CONTAINERS`
/// with caret evidence, or an unknown custom role with caret evidence and a
/// text AXValue; never under a grid. `facts` and `ancestors` are only read
/// for such roles.
pub fn classify_target(
    role: &str,
    subrole: Option<&str>,
    facts: impl FnOnce() -> EditFacts,
    ancestors: impl FnOnce() -> Vec<String>,
) -> (&'static str, bool, Option<&'static str>) {
    let base = classify_role(effective_role(role, subrole));
    // "unknown": the AXRole itself could not be read (`build_snapshot`).
    if base.0 != "unsupported" || role == "unknown" {
        return base;
    }
    if GRID_ROLES.contains(&role) {
        return ("unsupported", false, Some(GRID_REASON));
    }
    if NEVER_PASTE_ROLES.contains(&role) {
        return base;
    }
    let facts = facts();
    if !facts.caret() {
        return base;
    }
    if !PASTE_ONLY_CONTAINERS.contains(&role) && !facts.text_value {
        return base;
    }
    if is_grid_selection(role, &ancestors()) {
        return ("unsupported", false, Some(GRID_REASON));
    }
    ("insertable", true, None)
}

#[cfg(test)]
#[path = "paste_role_tests.rs"]
mod tests;
