//! Layout-aware keycode for the V of ⌘V. Dvorak and some other layouts put V
//! on a different physical key, and a fixed keycode would post another
//! shortcut there (VoiceInk #652).

/// kVK_ANSI_V: the physical key QWERTY labels V. Used when no key of the
/// current layout produces "v" (or the layout cannot be read).
pub const KEYCODE_ANSI_V: u16 = 9;

/// First virtual keycode (0..=127) that types "v" under the Command modifier.
/// `translate(keycode)` is the layout's character for that key, e.g. from
/// `UCKeyTranslate`; Command layouts such as "Dvorak – QWERTY ⌘" report the
/// QWERTY letter, which is what ⌘ shortcuts use.
pub fn keycode_for_v(translate: impl Fn(u16) -> Option<String>) -> u16 {
    (0u16..128)
        .find(|key| translate(*key).is_some_and(|s| s.eq_ignore_ascii_case("v")))
        .unwrap_or(KEYCODE_ANSI_V)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(v_key: Option<u16>) -> impl Fn(u16) -> Option<String> {
        move |key| {
            let ch = if Some(key) == v_key { "v" } else { "x" };
            // Keys the layout does not map return nothing.
            (key < 100).then(|| ch.to_string())
        }
    }

    #[test]
    fn follows_the_layout_not_the_qwerty_position() {
        assert_eq!(keycode_for_v(layout(Some(9))), 9, "QWERTY, AZERTY, Colemak");
        // Dvorak puts V on the key QWERTY labels "/" (kVK_ANSI_Slash).
        assert_eq!(keycode_for_v(layout(Some(44))), 44);
    }

    #[test]
    fn falls_back_to_ansi_v_when_the_layout_has_no_v() {
        assert_eq!(keycode_for_v(layout(None)), KEYCODE_ANSI_V);
        assert_eq!(keycode_for_v(|_| None), KEYCODE_ANSI_V);
    }

    #[test]
    fn matches_either_case_and_the_lowest_key() {
        let upper = |key: u16| (key == 20 || key == 30).then(|| "V".to_string());
        assert_eq!(keycode_for_v(upper), 20);
        // A multi-character result (dead key, ligature) is not a V.
        assert_eq!(keycode_for_v(|key| (key == 5).then(|| "vv".to_string())), 9);
    }
}
