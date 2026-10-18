use super::super::ax::test_support::Owned;
use super::*;

#[derive(Default)]
struct Registry {
    slot: Mutex<Option<Slot>>,
    next: Mutex<u64>,
}
impl Registry {
    fn register(&self, value: &Owned) -> Option<u64> {
        register_in(value.0 as AXUIElementRef, &self.slot, &self.next)
    }
    fn matching(&self, value: &Owned) -> Option<u64> {
        matching_generation_in(value.0 as AXUIElementRef, &self.slot)
    }
}
impl Drop for Registry {
    fn drop(&mut self) {
        // Cleanup even after a test panic or deliberate lock poisoning.
        let slot = self.slot.get_mut().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = slot.take() {
            release(old.element as CFTypeRef);
        }
    }
}

#[test]
fn replacement_releases_old_target_and_invalidates_old_generation() {
    let a = Owned::string("heap allocated completion field A, not a tagged string");
    let b = Owned::string("heap allocated completion field B, not a tagged string");
    let r = Registry::default();
    let (a_count, b_count) = (a.count(), b.count());
    assert_eq!(r.matching(&a), None);
    let first = r.register(&a).unwrap();
    assert_eq!(a.count(), a_count + 1);
    assert_eq!(r.matching(&a), Some(first));
    let second = r.register(&b).unwrap();
    assert!(second > first);
    assert_eq!(a.count(), a_count);
    assert_eq!(b.count(), b_count + 1);
    assert_eq!(r.matching(&a), None);
    assert_eq!(r.matching(&b), Some(second));
    drop(r);
    assert_eq!(b.count(), b_count);
}

#[test]
fn concurrent_registration_and_matching_preserve_owned_target_until_replacement() {
    use std::sync::{mpsc, Barrier};

    const A: &str = "heap allocated concurrent completion field A, not a tagged string";
    const B: &str = "heap allocated concurrent completion field B, not a tagged string";
    let a = Owned::string(A);
    let r = Registry::default();
    let original_count = a.count();
    let first = r.register(&a).unwrap();
    let gate = Barrier::new(3);
    let (registered_tx, registered_rx) = mpsc::channel();
    let (observed_tx, observed_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        // Both workers contend for this isolated slot; no global registry,
        // raw-pointer Send wrapper, sleeps, or focused AX object is involved.
        let (r, gate) = (&r, &gate);
        let held_slot = r.slot.lock().unwrap();
        let writer = scope.spawn(move || {
            let b = Owned::string(B);
            let count = b.count();
            gate.wait();
            let second = r.register(&b).unwrap();
            let retained_count = b.count();
            registered_tx.send(second).unwrap();
            observed_rx.recv().unwrap();
            assert_eq!(retained_count, count + 1, "replacement must own a retain");
            assert_eq!(b.count(), count + 1, "matching must not release the target");
            second
        });
        let reader = scope.spawn(move || {
            // Equal-but-distinct CF objects exercise the real CFEqual path.
            let equal_a = Owned::string(A);
            let equal_b = Owned::string(B);
            gate.wait();
            let racing_match = r.matching(&equal_a);
            let second = registered_rx.recv().unwrap();
            let old_after = r.matching(&equal_a);
            let new_after = r.matching(&equal_b);
            observed_tx.send(()).unwrap();
            // Either lock winner is valid, but no invented/stale generation is.
            assert!(racing_match == Some(first) || racing_match.is_none());
            assert!(second > first);
            assert_eq!(
                old_after, None,
                "replacement invalidates the old generation"
            );
            assert_eq!(new_after, Some(second));
        });
        gate.wait();
        let while_locked_count = a.count();
        let while_locked_generation = held_slot.as_ref().unwrap().generation;
        // Release before assertions/join so failures cannot strand workers.
        drop(held_slot);
        reader.join().unwrap();
        let second = writer.join().unwrap();
        assert_eq!(
            while_locked_count,
            original_count + 1,
            "old target released while locked"
        );
        assert_eq!(while_locked_generation, first);
        assert!(second > first);
    });
    assert_eq!(
        a.count(),
        original_count,
        "replacement must release the old retain"
    );
    assert_eq!(r.matching(&a), None);
    // The writer's fixture has dropped: only the registry now owns B.
    assert_eq!(r.matching(&Owned::string(B)), Some(first + 1));
    drop(r);
    assert_eq!(a.count(), original_count);
}

#[test]
fn identity_uses_cf_equality_not_pointer_or_attribute_tokens() {
    // CFString is a safe stand-in for an owned CFType: exercise the real
    // CFRetain/CFEqual contract, not live AX identity or GUI permissions.
    let a = Owned::string("equal heap allocated values with different addresses");
    let equal = Owned::string("equal heap allocated values with different addresses");
    assert_ne!(a.0, equal.0);
    let r = Registry::default();
    let first = r.register(&a).unwrap();
    assert_eq!(r.matching(&equal), Some(first));
    let second = r.register(&equal).unwrap();
    assert!(
        second > first,
        "a fresh completion invalidates even the same field's old token"
    );
    assert_eq!(r.matching(&a), Some(second));
}

#[test]
fn poisoned_registry_does_not_retain_a_target_it_cannot_store() {
    let a = Owned::string("heap allocated object for poisoned registry retain accounting");
    let r = Registry::default();
    let _ = std::panic::catch_unwind(|| {
        let _lock = r.slot.lock().unwrap();
        panic!("deliberate isolated registry poison");
    });
    let count = a.count();
    assert_eq!(r.register(&a), None);
    let after = a.count();
    // Keep the regression failure itself leak-free on the known-bad baseline.
    for _ in count..after {
        release(a.0);
    }
    assert_eq!(after, count, "failed registration leaked a CF retain");
    assert_eq!(r.matching(&a), None);
}

#[test]
fn poisoned_generation_counter_preserves_previous_registration() {
    let a = Owned::string("heap allocated previous completion registration object");
    let b = Owned::string("heap allocated next completion registration object");
    let r = Registry::default();
    let first = r.register(&a).unwrap();
    let count = b.count();
    let _ = std::panic::catch_unwind(|| {
        let _lock = r.next.lock().unwrap();
        panic!("deliberate isolated generation poison");
    });
    assert_eq!(r.register(&b), None);
    assert_eq!(b.count(), count);
    assert_eq!(r.matching(&a), Some(first));
}
