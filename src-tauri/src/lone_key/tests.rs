use super::machine::{Edge, Kind, LoneKeyMachine, DEBOUNCE_MS};
use super::{parse_token, LoneKey};

const RALT: u16 = 61;
const LALT: u16 = 58;
const LSHIFT: u16 = 56;
const KEY_E: u16 = 14;
const F13: u16 = 105;

// Flags as macOS reports them while a modifier is down.
const R_OPT: u64 = (1 << 19) | 0x40;
const L_OPT: u64 = (1 << 19) | 0x20;
const L_SHIFT: u64 = (1 << 17) | 0x02;

fn machine(token: &str) -> LoneKeyMachine {
    LoneKeyMachine::new(parse_token(token).unwrap())
}

fn key(token: &str) -> LoneKey {
    parse_token(token).unwrap()
}

#[test]
fn parses_right_hand_modifiers_and_f_keys_by_keycode() {
    for (token, code) in [
        ("AltRight", 61),
        ("ControlRight", 62),
        ("MetaRight", 54),
        ("ShiftRight", 60),
        ("F13", 105),
        ("F14", 107),
        ("F15", 113),
        ("F16", 106),
        ("F17", 64),
        ("F18", 79),
        ("F19", 80),
    ] {
        assert_eq!(key(token).keycode, code, "{token}");
    }
}

#[test]
fn rejects_left_hand_modifiers_combos_and_other_keys() {
    for token in [
        "AltLeft",
        "ShiftLeft",
        "F12",
        "F20",
        "K",
        "Alt + K",
        "Ctrl + Shift + Space",
        "",
    ] {
        assert!(parse_token(token).is_err(), "{token}");
    }
}

#[test]
fn quick_tap_emits_pressed_then_released_together() {
    let mut m = machine("AltRight");
    assert!(m.step(Kind::FlagsChanged, RALT, R_OPT, 0).is_empty());
    assert_eq!(
        m.step(Kind::FlagsChanged, RALT, 0, 40),
        [Edge::Pressed, Edge::Released]
    );
}

#[test]
fn hold_emits_pressed_after_the_debounce_then_released() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 100);
    assert_eq!(m.pending_since(), Some(100));
    assert!(m.tick(100 + DEBOUNCE_MS - 1).is_empty());
    assert_eq!(m.tick(100 + DEBOUNCE_MS), [Edge::Pressed]);
    assert_eq!(m.pending_since(), None);
    assert!(m.tick(500).is_empty(), "Pressed is emitted once");
    assert_eq!(m.step(Kind::FlagsChanged, RALT, 0, 600), [Edge::Released]);
}

#[test]
fn an_event_after_the_debounce_emits_the_due_pressed_first() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    assert_eq!(
        m.step(Kind::FlagsChanged, RALT, 0, 300),
        [Edge::Pressed, Edge::Released]
    );
}

#[test]
fn another_key_before_the_debounce_emits_nothing() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    assert!(m.step(Kind::KeyDown, KEY_E, R_OPT, 30).is_empty());
    assert!(m.tick(500).is_empty());
    assert!(m.step(Kind::KeyUp, KEY_E, R_OPT, 520).is_empty());
    assert!(m.step(Kind::FlagsChanged, RALT, 0, 540).is_empty());
}

#[test]
fn another_key_after_pressed_releases_and_cancels() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    m.tick(DEBOUNCE_MS);
    assert_eq!(
        m.step(Kind::KeyDown, KEY_E, R_OPT, 200),
        [Edge::Released, Edge::Cancelled]
    );
    assert!(
        m.step(Kind::FlagsChanged, RALT, 0, 260).is_empty(),
        "no second release"
    );
}

#[test]
fn a_dirty_press_ends_cleanly_and_the_next_press_works() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    m.step(Kind::KeyDown, KEY_E, R_OPT, 10);
    m.step(Kind::FlagsChanged, RALT, 0, 20);
    m.step(Kind::FlagsChanged, RALT, R_OPT, 1000);
    assert_eq!(
        m.step(Kind::FlagsChanged, RALT, 0, 1020),
        [Edge::Pressed, Edge::Released]
    );
}

#[test]
fn a_second_modifier_makes_it_a_chord() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    assert!(m
        .step(Kind::FlagsChanged, LSHIFT, R_OPT | L_SHIFT, 20)
        .is_empty());
    assert!(m.step(Kind::FlagsChanged, RALT, L_SHIFT, 60).is_empty());
}

#[test]
fn left_option_joining_makes_it_a_chord_and_alone_is_ignored() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    m.tick(DEBOUNCE_MS);
    assert_eq!(
        m.step(Kind::FlagsChanged, LALT, R_OPT | L_OPT, 150),
        [Edge::Released, Edge::Cancelled]
    );
    let mut m = machine("AltRight");
    assert!(m.step(Kind::FlagsChanged, LALT, L_OPT, 0).is_empty());
    assert!(m.step(Kind::FlagsChanged, LALT, 0, 30).is_empty());
    assert_eq!(m.pending_since(), None);
}

#[test]
fn a_modifier_already_held_at_press_time_is_a_chord() {
    let mut m = machine("AltRight");
    assert!(m
        .step(Kind::FlagsChanged, RALT, R_OPT | L_SHIFT, 0)
        .is_empty());
    assert_eq!(m.pending_since(), None);
    assert!(m.step(Kind::FlagsChanged, RALT, L_SHIFT, 30).is_empty());
}

#[test]
fn a_mouse_button_makes_it_a_chord() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    m.tick(DEBOUNCE_MS);
    assert_eq!(
        m.step(Kind::MouseDown, 0, R_OPT, 120),
        [Edge::Released, Edge::Cancelled]
    );
}

#[test]
fn releasing_another_modifier_does_not_dirty_a_clean_press() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    assert!(
        m.step(Kind::FlagsChanged, 57, R_OPT, 10).is_empty(),
        "caps lock toggle"
    );
    assert_eq!(
        m.step(Kind::FlagsChanged, RALT, 0, 30),
        [Edge::Pressed, Edge::Released]
    );
}

#[test]
fn tap_disabled_releases_a_hold_and_forgets_a_pending_press() {
    let mut m = machine("AltRight");
    m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
    m.tick(DEBOUNCE_MS);
    assert_eq!(
        m.step(Kind::TapDisabled, 0, 0, 500),
        [Edge::Released, Edge::Cancelled]
    );
    assert!(m.step(Kind::FlagsChanged, RALT, 0, 520).is_empty());
    m.step(Kind::FlagsChanged, RALT, R_OPT, 600);
    assert!(m.step(Kind::TapDisabled, 0, 0, 610).is_empty());
    assert!(m.tick(1000).is_empty());
}

#[test]
fn f_key_press_hold_and_chord() {
    let mut m = machine("F13");
    m.step(Kind::KeyDown, F13, 0, 0);
    m.step(Kind::KeyDown, F13, 0, 30); // auto-repeat
    assert_eq!(m.tick(DEBOUNCE_MS), [Edge::Pressed]);
    assert_eq!(m.step(Kind::KeyUp, F13, 0, 400), [Edge::Released]);
    // Option+F13 is not the lone F13.
    assert!(m.step(Kind::KeyDown, F13, R_OPT, 500).is_empty());
    assert!(m.step(Kind::KeyUp, F13, R_OPT, 520).is_empty());
    // Another key during F13 cancels an active hold.
    m.step(Kind::KeyDown, F13, 0, 600);
    m.tick(700);
    assert_eq!(
        m.step(Kind::KeyDown, KEY_E, 0, 720),
        [Edge::Released, Edge::Cancelled]
    );
}

#[test]
fn other_lone_modifiers_are_told_apart_by_side() {
    // Right Shift held while Left Shift joins is a chord; Left Shift alone is ignored.
    let mut m = machine("ShiftRight");
    let r_shift = (1 << 17) | 0x04;
    m.step(Kind::FlagsChanged, 60, r_shift, 0);
    assert!(m
        .step(Kind::FlagsChanged, LSHIFT, r_shift | 0x02, 10)
        .is_empty());
    let mut m = machine("ShiftRight");
    assert!(m.step(Kind::FlagsChanged, LSHIFT, L_SHIFT, 0).is_empty());
    assert_eq!(m.pending_since(), None);
}
