use super::*;

#[test]
fn escape_only_cancels_while_popup_is_active() {
    let mut scope = ScopeState::new("one".into());
    assert_eq!(scope.event(10, 53), Action::Pass);
    scope.visible = true;
    assert_eq!(scope.event(10, 0), Action::Pass);
    assert_eq!(scope.event(11, 53), Action::Pass);
    assert_eq!(scope.event(10, 53), Action::CancelAndSwallow);
    assert!(scope.cancelled);
    assert!(!scope.visible);
    assert_eq!(scope.event(10, 53), Action::Pass);
    assert_eq!(scope.event(11, 53), Action::Pass);
}

#[test]
fn disabled_tap_fails_closed_without_swallowing_or_rearming() {
    for event in [u32::MAX, u32::MAX - 1] {
        let mut scope = ScopeState::new("one".into());
        scope.visible = true;
        assert_eq!(scope.event(event, 0), Action::Cancel);
        assert!(scope.cancelled);
        assert_eq!(scope.event(10, 53), Action::Pass);
    }
}

#[test]
fn cancelled_session_cannot_claim_delivery_but_next_session_can() {
    let mut scope = ScopeState::new("one".into());
    scope.visible = true;
    scope.event(10, 53);
    assert!(!scope.can_finish("one"));
    let next = ScopeState::new("two".into());
    assert!(!next.can_finish("one"));
    assert!(next.can_finish("two"));
}
