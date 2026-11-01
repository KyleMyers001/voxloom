//! Edge cases from review: tap loss, rollover, repeats, F-key chords, stale
//! wake-ups and the right-hand device masks.

use super::machine::{Edge, Kind, LoneKeyMachine, DEBOUNCE_MS};
use super::parse_token;

const RALT: u16 = 61;
const KEY_E: u16 = 14;
const KEY_A: u16 = 0;
const F13: u16 = 105;
const R_OPT: u64 = (1 << 19) | 0x40;
const L_CMD: u64 = (1 << 20) | 0x08;
const R_CMD: u64 = (1 << 20) | 0x10;
const R_CTL: u64 = (1 << 18) | 0x2000;
const L_CTL: u64 = (1 << 18) | 0x01;

fn machine(token: &str) -> LoneKeyMachine {
    LoneKeyMachine::new(parse_token(token).unwrap())
}

#[test]
fn tap_disabled_after_the_deadline_drops_a_pending_press_silently() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    // 500 ms with no event, then the tap is lost: no Pressed, Released, Cancelled.
    assert!(m.step(Kind::TapDisabled, 0, 0, 500).is_empty());
    assert!(m.tick(1000).is_empty());
    assert!(m.step(Kind::FlagsChanged, RALT, 0, 1100).is_empty());
}

#[test]
fn tap_disabled_still_closes_an_emitted_press_once() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    m.tick(DEBOUNCE_MS);
    assert_eq!(
        m.step(Kind::TapDisabled, 0, 0, 900),
        [Edge::Released, Edge::Cancelled]
    );
    assert!(m.step(Kind::TapDisabled, 0, 0, 910).is_empty());
}

#[test]
fn rollover_from_a_held_key_into_the_modifier_is_a_chord() {
    let mut m = machine("AltRight");
    m.step(Kind::KeyDown, KEY_E, 0, 0);
    assert!(m.step(Kind::FlagsChanged, RALT, R_OPT, 20).is_empty());
    assert!(m.step(Kind::FlagsChanged, RALT, 0, 60).is_empty());
    assert!(m.tick(500).is_empty());
}

#[test]
fn rollover_clears_once_the_other_key_is_up() {
    let mut m = machine("AltRight");
    m.step(Kind::KeyDown, KEY_E, 0, 0);
    m.step(Kind::KeyUp, KEY_E, 0, 30);
    m.step(Kind::FlagsChanged, RALT, R_OPT, 50);
    assert_eq!(
        m.step(Kind::FlagsChanged, RALT, 0, 90),
        [Edge::Pressed, Edge::Released]
    );
}

#[test]
fn rollover_applies_to_an_f_key_and_tap_loss_forgets_held_keys() {
    let mut m = machine("F13");
    m.step(Kind::KeyDown, KEY_A, 0, 0);
    assert!(m.step(Kind::KeyDown, F13, 0, 20).is_empty());
    assert!(m.step(Kind::KeyUp, F13, 0, 40).is_empty());
    m.step(Kind::TapDisabled, 0, 0, 100);
    m.step(Kind::KeyDown, F13, 0, 200);
    assert_eq!(
        m.step(Kind::KeyUp, F13, 0, 230),
        [Edge::Pressed, Edge::Released]
    );
}

#[test]
fn a_held_key_that_never_comes_up_expires() {
    let mut m = machine("AltRight");
    m.step(Kind::KeyDown, KEY_E, 0, 0);
    m.step(Kind::FlagsChanged, RALT, R_OPT, 20_000);
    assert_eq!(
        m.step(Kind::FlagsChanged, RALT, 0, 20_030),
        [Edge::Pressed, Edge::Released]
    );
}

#[test]
fn a_repeat_keeps_a_held_key_fresh() {
    let mut m = machine("AltRight");
    m.step(Kind::KeyDown, KEY_E, 0, 0);
    m.step(Kind::KeyRepeat, KEY_E, 0, 9_000);
    m.step(Kind::KeyRepeat, KEY_E, 0, 18_000);
    assert!(m.step(Kind::FlagsChanged, RALT, R_OPT, 20_000).is_empty());
    assert_eq!(m.pending_since(), None);
}

#[test]
fn a_repeating_f_key_never_starts_a_press() {
    let mut m = machine("F13");
    // F13 was down when the tap came back: only repeats arrive, then keyUp.
    assert!(m.step(Kind::KeyRepeat, F13, 0, 0).is_empty());
    assert_eq!(m.pending_since(), None);
    assert!(m.tick(500).is_empty());
    assert!(m.step(Kind::KeyRepeat, F13, 0, 600).is_empty());
    assert!(m.step(Kind::KeyUp, F13, 0, 700).is_empty());
    // A fresh keyDown afterwards is a real press.
    m.step(Kind::KeyDown, F13, 0, 800);
    assert_eq!(m.tick(800 + DEBOUNCE_MS), [Edge::Pressed]);
}

#[test]
fn a_repeat_of_another_key_while_idle_is_remembered_as_held() {
    let mut m = machine("AltRight");
    m.step(Kind::KeyRepeat, KEY_E, 0, 0);
    assert!(m.step(Kind::FlagsChanged, RALT, R_OPT, 50).is_empty());
    assert_eq!(m.pending_since(), None);
}

#[test]
fn a_modifier_joining_an_f_key_press_makes_it_a_chord() {
    let mut m = machine("F13");
    m.step(Kind::KeyDown, F13, 0, 0);
    assert!(m.step(Kind::FlagsChanged, 58, R_OPT, 20).is_empty());
    assert!(m.step(Kind::KeyUp, F13, R_OPT, 60).is_empty());
    let mut m = machine("F13");
    m.step(Kind::KeyDown, F13, 0, 0);
    m.tick(DEBOUNCE_MS);
    assert_eq!(
        m.step(Kind::FlagsChanged, 58, R_OPT, 150),
        [Edge::Released, Edge::Cancelled]
    );
}

#[test]
fn a_wake_up_from_an_earlier_press_does_not_fire_the_next_one_early() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    m.step(Kind::FlagsChanged, RALT, 0, 30);
    m.step(Kind::FlagsChanged, RALT, R_OPT, 60);
    // The first press's wake-up lands at 80: the second isn't due until 140.
    assert!(m.tick(DEBOUNCE_MS).is_empty());
    assert_eq!(m.tick(60 + DEBOUNCE_MS), [Edge::Pressed]);
}

#[test]
fn a_wake_up_after_re_arming_does_nothing() {
    // Re-arming builds a fresh machine; a late tick finds nothing pending.
    assert!(machine("AltRight").tick(10_000).is_empty());
}

#[test]
fn right_command_and_right_control_use_their_own_device_bits() {
    for (token, code, own, left) in [
        ("MetaRight", 54, R_CMD, L_CMD),
        ("ControlRight", 62, R_CTL, L_CTL),
    ] {
        let mut m = machine(token);
        m.step(Kind::FlagsChanged, code, own, 0);
        assert_eq!(
            m.step(Kind::FlagsChanged, code, 0, 30),
            [Edge::Pressed, Edge::Released],
            "{token}"
        );
        // The left-hand twin is a different key, and joining makes a chord.
        let mut m = machine(token);
        assert!(
            m.step(Kind::FlagsChanged, 55, left, 0).is_empty(),
            "{token}"
        );
        assert_eq!(m.pending_since(), None, "{token}");
        m.step(Kind::FlagsChanged, code, own, 100);
        m.tick(100 + DEBOUNCE_MS);
        assert_eq!(
            m.step(Kind::FlagsChanged, 55, own | left, 300),
            [Edge::Released, Edge::Cancelled],
            "{token}"
        );
    }
}
