//! Prior-clipboard classification, restore decision and insert report.

use serde::Serialize;

/// What the clipboard held before our temporary paste.
#[derive(Debug, PartialEq, Eq)]
pub enum ClipboardPrior {
    /// Only plain-text flavors: safe to restore byte-for-byte via pbcopy.
    PlainText(String),
    /// Image / file / rich (RTF, HTML) or any non-text flavor: pbpaste cannot
    /// capture it, so restoring would overwrite it with a lossy/empty string.
    NonText,
    /// Nothing on the clipboard (no flavors).
    Empty,
    /// Could not inspect the clipboard.
    Unreadable,
}

/// Plain-text pasteboard flavors as reported by AppleScript `clipboard info`.
const PLAIN_TEXT_FLAVORS: &[&str] = &[
    "string",
    "unicode text",
    "text",
    "«class utf8»",
    "«class ut16»",
    "utf8",
    "ut16",
];

/// Classify the prior clipboard from AppleScript `clipboard info` output
/// (e.g. `«class PNGf», 1234, string, 5`) plus the `pbpaste` text.
/// Any non-plain-text flavor → NonText (we cannot restore it faithfully).
pub fn classify_clipboard(info: Option<&str>, text: Option<&str>) -> ClipboardPrior {
    let Some(info) = info else {
        return ClipboardPrior::Unreadable;
    };
    let flavors: Vec<String> = info
        .split(',')
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty() && p.parse::<i64>().is_err())
        .collect();
    if flavors.is_empty() {
        return ClipboardPrior::Empty;
    }
    if flavors
        .iter()
        .any(|f| !PLAIN_TEXT_FLAVORS.contains(&f.as_str()))
    {
        return ClipboardPrior::NonText;
    }
    match text {
        // Text flavors present but pbpaste returned nothing: do not trust it.
        Some(t) if !t.is_empty() => ClipboardPrior::PlainText(t.to_string()),
        Some(_) => ClipboardPrior::NonText,
        None => ClipboardPrior::Unreadable,
    }
}

/// Clipboard restore decision after a temporary paste.
#[derive(Debug, PartialEq, Eq)]
pub enum RestoreDecision {
    Restore(String),
    Skip(&'static str),
}

pub fn restore_decision(prior: &ClipboardPrior, now: Option<&str>, text: &str) -> RestoreDecision {
    let prev = match prior {
        ClipboardPrior::PlainText(p) => p,
        ClipboardPrior::NonText => {
            return RestoreDecision::Skip(
                "clipboard held non-text data (image, file or rich text) that cannot be restored",
            )
        }
        ClipboardPrior::Empty => return RestoreDecision::Skip("clipboard was empty before paste"),
        ClipboardPrior::Unreadable => {
            return RestoreDecision::Skip("original clipboard could not be read")
        }
    };
    match now {
        Some(now) if now == text => RestoreDecision::Restore(prev.clone()),
        Some(_) => RestoreDecision::Skip("clipboard changed after our write"),
        None => RestoreDecision::Skip("clipboard could not be re-read"),
    }
}

/// Native insert result surfaced to TypeScript.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InsertReport {
    /// Delivered by temporary clipboard paste (web content).
    pub pasted: bool,
    /// Prior clipboard restored after the paste.
    pub clipboard_restored: bool,
    /// Why restore was skipped (conflict, unreadable, write failure).
    pub restore_skipped_reason: Option<String>,
}

#[cfg(test)]
#[path = "clipboard_tests.rs"]
mod tests;
