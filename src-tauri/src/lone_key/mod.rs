//! BUS-46: native detection of a lone key as the whole dictation
//! shortcut (a right-hand modifier or F13-F19). The global-shortcut plugin
//! cannot register these, so a pass-through event tap feeds a pure state
//! machine that emits the same Pressed/Released edges the plugin does.
//!
//! `commands` wire it to the app (arm / disarm / request access / the edge
//! event), with edges delivered off the tap callback (`delivery`).
//!
//! macOS only. Elsewhere `arm` refuses, and the pure parts below are built
//! (and tested) but unused, hence the `dead_code` allows.

pub mod commands;
#[cfg(target_os = "macos")]
mod context;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod delivery;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub mod machine;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod tap_ffi;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_boundaries;
#[cfg(test)]
mod tests_delivery;
#[cfg(test)]
mod tests_edge;
#[cfg(test)]
mod tests_pins;

// CGEventFlags: generic modifier bits.
const FLAG_SHIFT: u64 = 1 << 17;
const FLAG_CONTROL: u64 = 1 << 18;
const FLAG_OPTION: u64 = 1 << 19;
const FLAG_COMMAND: u64 = 1 << 20;
pub(crate) const GENERIC_MODIFIERS: u64 = FLAG_SHIFT | FLAG_CONTROL | FLAG_OPTION | FLAG_COMMAND;

// NX_DEVICE*KEYMASK: which physical side is down (low 16 bits of the flags).
const DEVICE_LCTL: u64 = 0x0001;
const DEVICE_LSHIFT: u64 = 0x0002;
const DEVICE_RSHIFT: u64 = 0x0004;
const DEVICE_LCMD: u64 = 0x0008;
const DEVICE_RCMD: u64 = 0x0010;
const DEVICE_LALT: u64 = 0x0020;
const DEVICE_RALT: u64 = 0x0040;
const DEVICE_RCTL: u64 = 0x2000;
pub(crate) const DEVICE_MODIFIERS: u64 = DEVICE_LCTL
    | DEVICE_LSHIFT
    | DEVICE_RSHIFT
    | DEVICE_LCMD
    | DEVICE_RCMD
    | DEVICE_LALT
    | DEVICE_RALT
    | DEVICE_RCTL;

/// A configured lone key: which keycode it is and, for a modifier, the flag
/// bits that say it (and only its side) is down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoneKey {
    pub keycode: u16,
    /// Device-side bit for a modifier; 0 for a function key.
    pub(crate) device_mask: u64,
    /// Generic modifier bit for a modifier; 0 for a function key.
    pub(crate) generic_mask: u64,
}

impl LoneKey {
    pub(crate) fn is_modifier(self) -> bool {
        self.device_mask != 0
    }

    /// Modifier flags held other than this key's own. Any of them at press
    /// time, or arriving during it, makes the press a chord.
    pub(crate) fn other_modifiers(self, flags: u64) -> u64 {
        (flags & GENERIC_MODIFIERS & !self.generic_mask)
            | (flags & DEVICE_MODIFIERS & !self.device_mask)
    }
}

const fn modifier(keycode: u16, device_mask: u64, generic_mask: u64) -> LoneKey {
    LoneKey {
        keycode,
        device_mask,
        generic_mask,
    }
}

const fn f_key(keycode: u16) -> LoneKey {
    modifier(keycode, 0, 0)
}

/// Map a stored lone-key token (`settings.shortcut`, e.g. "AltRight", "F13")
/// to its macOS keycode. Left-hand modifiers and combos are not lone keys.
pub fn parse_token(token: &str) -> Result<LoneKey, String> {
    Ok(match token.trim() {
        "AltRight" => modifier(61, DEVICE_RALT, FLAG_OPTION),
        "ControlRight" => modifier(62, DEVICE_RCTL, FLAG_CONTROL),
        "MetaRight" => modifier(54, DEVICE_RCMD, FLAG_COMMAND),
        "ShiftRight" => modifier(60, DEVICE_RSHIFT, FLAG_SHIFT),
        "F13" => f_key(105),
        "F14" => f_key(107),
        "F15" => f_key(113),
        "F16" => f_key(106),
        "F17" => f_key(64),
        "F18" => f_key(79),
        "F19" => f_key(80),
        other => return Err(format!("not a lone-key shortcut: '{other}'")),
    })
}
