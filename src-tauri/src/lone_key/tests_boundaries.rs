//! Pins for the held-key bookkeeping edges (expiry, the 16-key cap) and for
//! the debounce check inside `step()`, which fuzzing can't see.

use super::machine::{Edge, Kind, LoneKeyMachine, DEBOUNCE_MS};
use super::parse_token;

const RALT: u16 = 61;
const KEY_E: u16 = 14;
const R_OPT: u64 = (1 << 19) | 0x40;
const CAP: u16 = 16;

fn machine() -> LoneKeyMachine {
    LoneKeyMachine::new(parse_token("AltRight").unwrap())
}

/// Tap the modifier at `now`; what it emits tells clean (both edges) from a
/// chord (nothing).
fn tap(m: &mut LoneKeyMachine, now: u64) -> Vec<Edge> {
    m.step(Kind::FlagsChanged, RALT, R_OPT, now);
    m.step(Kind::FlagsChanged, RALT, 0, now + 1)
}

#[test]
fn a_held_key_still_counts_at_9_999_ms_and_is_forgotten_at_10_000() {
    for (at, clean) in [(9_999, false), (10_000, true)] {
        let mut m = machine();
        m.step(Kind::KeyDown, KEY_E, 0, 0);
        assert_eq!(tap(&mut m, at).is_empty(), !clean, "press at {at} ms");
    }
}

#[test]
fn sixteen_held_keys_are_tracked_and_a_seventeenth_is_not() {
    // Keys 1..=16 held, then all but the last released: the last one alone
    // must still make a tap a chord, so the cap is at least 16.
    let mut m = machine();
    for code in 1..=CAP {
        m.step(Kind::KeyDown, code, 0, 0);
    }
    for code in 1..CAP {
        m.step(Kind::KeyUp, code, 0, 10);
    }
    assert!(tap(&mut m, 20).is_empty(), "the 16th key is tracked");

    // A 17th key down is dropped (QA I1), so once 1..=16 are up the tap is
    // clean: the cap is at most 16.
    let mut m = machine();
    for code in 1..=CAP + 1 {
        m.step(Kind::KeyDown, code, 0, 0);
    }
    for code in 1..=CAP {
        m.step(Kind::KeyUp, code, 0, 10);
    }
    assert_eq!(tap(&mut m, 20), [Edge::Pressed, Edge::Released]);
}

#[test]
fn a_full_set_of_stale_keys_makes_room_for_a_real_one() {
    let mut m = machine();
    for code in 1..=CAP {
        m.step(Kind::KeyDown, code, 0, 0);
    }
    // 10 s later all 16 are stale; a new key down is tracked, not dropped.
    m.step(Kind::KeyDown, 99, 0, 10_000);
    assert!(tap(&mut m, 10_001).is_empty());
}

#[test]
fn step_emits_a_due_press_on_any_unrelated_event() {
    // The debounce check inside step(): no tick call, just a later event.
    for (event_at, due) in [(DEBOUNCE_MS - 1, false), (DEBOUNCE_MS, true)] {
        let mut m = machine();
        m.step(Kind::FlagsChanged, RALT, R_OPT, 0);
        let out = m.step(Kind::KeyUp, KEY_E, R_OPT, event_at);
        assert_eq!(out, if due { vec![Edge::Pressed] } else { vec![] });
    }
}
