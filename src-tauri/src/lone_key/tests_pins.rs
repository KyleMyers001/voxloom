//! Pins the exact numbers and the "what must NOT happen" cases.

use super::machine::{Edge, Kind, LoneKeyMachine, DEBOUNCE_MS};
use super::parse_token;

const RALT: u16 = 61;
const KEY_E: u16 = 14;
const KEY_SPACE: u16 = 49;
const F13: u16 = 105;
const R_OPT: u64 = (1 << 19) | 0x40;
const L_SHIFT: u64 = (1 << 17) | 0x02;

fn machine(token: &str) -> LoneKeyMachine {
    LoneKeyMachine::new(parse_token(token).unwrap())
}

#[test]
fn the_debounce_is_exactly_80_ms() {
    assert_eq!(DEBOUNCE_MS, 80);
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 1000);
    assert!(m.tick(1079).is_empty(), "79 ms is too early");
    assert_eq!(m.tick(1080), [Edge::Pressed], "80 ms is due");
    let mut m = machine("F13");
    m.step(Kind::KeyDown, F13, 0, 0);
    assert!(m.tick(79).is_empty());
    assert_eq!(m.tick(81), [Edge::Pressed]);
}

#[test]
fn a_late_second_key_drops_a_pending_press_silently() {
    // The tick was stalled past 80 ms; the dirtying event still wins.
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    assert!(m.step(Kind::KeyDown, KEY_E, R_OPT, 300).is_empty());
    assert!(m.tick(400).is_empty());
    assert!(m.step(Kind::FlagsChanged, RALT, 0, 500).is_empty());
    for (kind, code, flags) in [
        (Kind::MouseDown, 0, R_OPT),
        (Kind::FlagsChanged, 56, R_OPT | L_SHIFT),
    ] {
        let mut m = machine("AltRight");
        m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
        assert!(m.step(kind, code, flags, 200).is_empty(), "{kind:?}");
        assert!(
            m.step(Kind::FlagsChanged, RALT, 0, 300).is_empty(),
            "{kind:?}"
        );
    }
    let mut m = machine("F13");
    m.step(Kind::KeyDown, F13, 0, 0);
    assert!(m.step(Kind::KeyDown, KEY_E, 0, 300).is_empty());
}

#[test]
fn a_late_release_still_emits_the_due_press() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    assert_eq!(
        m.step(Kind::FlagsChanged, RALT, 0, 300),
        [Edge::Pressed, Edge::Released]
    );
}

#[test]
fn right_option_held_300_ms_over_a_held_key_never_presses() {
    let mut m = machine("AltRight");
    m.step(Kind::KeyDown, KEY_E, 0, 0);
    m.step(Kind::FlagsChanged, RALT, R_OPT, 50);
    assert!(m.tick(350).is_empty());
    assert!(m.step(Kind::FlagsChanged, RALT, 0, 350).is_empty());
}

#[test]
fn a_held_ordinary_key_blocks_an_f_key_too() {
    let mut m = machine("F13");
    m.step(Kind::KeyDown, KEY_SPACE, 0, 0);
    assert!(m.step(Kind::KeyDown, F13, 0, 40).is_empty());
    assert!(m.tick(500).is_empty());
    assert!(m.step(Kind::KeyUp, F13, 0, 600).is_empty());
}

#[test]
fn tap_disabled_goes_back_to_idle_not_dirty() {
    // From Pending, Active and Dirty alike, the next own press starts fresh.
    for steps in 0..3 {
        let mut m = machine("AltRight");
        m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
        match steps {
            1 => drop(m.tick(DEBOUNCE_MS)),
            2 => drop(m.step(Kind::KeyDown, KEY_E, R_OPT, 10)),
            _ => {}
        }
        m.step(Kind::TapDisabled, 0, 0, 500);
        m.step(Kind::FlagsChanged, RALT, R_OPT, 600);
        assert_eq!(m.pending_since(), Some(600), "from state {steps}");
    }
}

#[test]
fn another_keys_key_up_does_not_release_our_press() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    assert!(m.step(Kind::KeyUp, KEY_E, R_OPT, 20).is_empty());
    assert_eq!(m.pending_since(), Some(0), "still pending");
    m.tick(DEBOUNCE_MS);
    assert!(m.step(Kind::KeyUp, KEY_E, R_OPT, 200).is_empty());
    assert!(
        m.step(Kind::KeyUp, RALT, R_OPT, 220).is_empty(),
        "only flags release a modifier"
    );
    assert_eq!(m.step(Kind::FlagsChanged, RALT, 0, 300), [Edge::Released]);

    let mut m = machine("F13");
    m.step(Kind::KeyDown, F13, 0, 0);
    m.tick(DEBOUNCE_MS);
    assert!(m.step(Kind::KeyUp, KEY_E, 0, 200).is_empty());
    assert_eq!(m.step(Kind::KeyUp, F13, 0, 300), [Edge::Released]);
}

#[test]
fn repeats_after_a_dirty_chord_and_tap_loss_never_press() {
    let mut m = machine("F13");
    m.step(Kind::KeyDown, F13, 0, 0);
    m.step(Kind::KeyDown, KEY_E, 0, 20); // dirty chord
    m.step(Kind::TapDisabled, 0, 0, 100);
    assert!(m.step(Kind::KeyRepeat, F13, 0, 200).is_empty());
    assert!(m.tick(1000).is_empty());
    assert_eq!(m.pending_since(), None);
}

#[test]
fn a_press_with_a_modifier_already_down_is_dirty_not_idle() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT | L_SHIFT, 0);
    // A second "down" report for our key must not start a fresh press.
    m.step(Kind::FlagsChanged, RALT, R_OPT, 40);
    assert_eq!(m.pending_since(), None);
}
