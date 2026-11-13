//! BUS-223 (d): one delivery diagnostic line per native insert. It holds
//! only labels, AX error codes and Voxloom's own reason strings: never the
//! dictated text or any field contents (no field takes them).

use super::verify::AfterAx;

#[derive(Debug, Default)]
pub struct DeliveryDiag {
    pub bundle_id: Option<String>,
    pub role: Option<String>,
    pub subrole: Option<String>,
    /// `ValueStatus::label` before the write.
    pub value: String,
    /// `EditFacts::label`.
    pub settable: String,
    /// Path taken: ax, terminal, refuse.
    pub gate: &'static str,
    /// Why AX refused or failed (Voxloom's reason text).
    pub reason: Option<String>,
    /// The AXSelectedText write error, if any.
    pub ax_error: Option<String>,
    pub readback: &'static str,
    /// none, paste, or why the paste was skipped.
    pub fallback: String,
    pub readback_ms: u128,
    pub paste_ms: u128,
    pub total_ms: u128,
}

/// Read-back result label for the AX outcome.
pub fn readback_label(outcome: &AfterAx) -> &'static str {
    match outcome {
        AfterAx::Inserted => "confirmed",
        AfterAx::TypeFallback => "unchanged-typing",
        AfterAx::Failed(_) => "unchanged",
        AfterAx::Unverified => "changed-or-unknown",
    }
}

impl DeliveryDiag {
    pub fn line(&self) -> String {
        let opt = |v: &Option<String>| v.clone().unwrap_or_else(|| "-".into());
        format!(
            "[insert] delivery bundle={} role={} subrole={} value={} settable=[{}] gate={} \
             reason={:?} ax_error={:?} readback={} fallback={} readback_ms={} paste_ms={} total_ms={}",
            opt(&self.bundle_id),
            opt(&self.role),
            opt(&self.subrole),
            self.value,
            self.settable,
            self.gate,
            opt(&self.reason),
            opt(&self.ax_error),
            if self.readback.is_empty() { "-" } else { self.readback },
            if self.fallback.is_empty() { "none" } else { &self.fallback },
            self.readback_ms,
            self.paste_ms,
            self.total_ms,
        )
    }
}
