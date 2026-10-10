//! Focused-element lookup, snapshots and on-demand web AX enablement.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::ax::*;
use super::{host, registry};
use crate::delivery::decide::{classify_role, effective_role, element_token};
use crate::delivery::types::TargetSnapshotDto;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn focus_unavailable_reason(
    stage: &str,
    app_err: AXError,
    focus_err: AXError,
    null: bool,
) -> String {
    let null_suffix = if null { " (null)" } else { "" };
    format!(
        "Accessibility focus unavailable at {stage} (AX trusted=yes; \
         AXFocusedApplication={app_err}; AXFocusedUIElement={focus_err}{null_suffix})"
    )
}

/// Only successful requests are cached. Initialization does not authorize a
/// target: every retry still requires successful AX focus and PID validation.
static WEB_AX: Mutex<Option<HashSet<i32>>> = Mutex::new(None);

fn needs_web_ax(focused_role: Option<&str>) -> bool {
    matches!(
        focused_role,
        None | Some("AXWebArea" | "AXGroup" | "AXScrollArea")
    )
}

fn copy_focus(system: AXUIElementRef) -> (AXError, CFTypeRef) {
    let name = cfstr("AXFocusedUIElement");
    let mut focused: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(system, name, &mut focused) };
    release(name);
    (err, focused)
}

/// Focused element (caller releases) and app name.
fn focused_ui_element_once(stage: &str) -> Result<(AXUIElementRef, Option<String>), String> {
    let system = system_wide();
    if system.is_null() {
        return Err(format!(
            "Accessibility focus unavailable at {stage} (AX trusted=yes; system element null)"
        ));
    }
    let app = copy_attr(system, "AXFocusedApplication");
    let app_err = app.err().unwrap_or(AX_OK);
    let app_name = app
        .ok()
        .and_then(|a| copy_string_attr(a as AXUIElementRef, "AXTitle"));
    let (focus_err, focused) = copy_focus(system);
    if let Ok(app) = app {
        release(app);
    }
    release(system as CFTypeRef);
    if focus_err != AX_OK || focused.is_null() {
        let reason = focus_unavailable_reason(stage, app_err, focus_err, focused.is_null());
        release(focused);
        return Err(reason);
    }
    Ok((focused as AXUIElementRef, app_name))
}

/// Selection, validation and per-chunk insertion guards never bootstrap or
/// acquire WEB_AX: a background warm-up cannot delay a UI/shortcut focus read.
pub fn focused_ui_element(stage: &str) -> Result<(AXUIElementRef, Option<String>), String> {
    focused_ui_element_once(stage)
}

/// Bootstrap only an independently identified, allowlisted foreground host.
/// Never use an AX value returned with an error as an initialization target.
/// A successful request only enables requery; it does not make a field safe.
fn warm_web_ax(
    stage: &str,
    front: Option<i32>,
) -> Result<(AXUIElementRef, Option<String>), String> {
    if host::frontmost_pid() != front {
        return Err("Accessibility bootstrap skipped — foreground changed".into());
    }
    let activation = front.and_then(host::web_ax_activation);
    let initial = focused_ui_element_once(stage);
    let role = initial
        .as_ref()
        .ok()
        .and_then(|(el, _)| copy_string_attr(*el, "AXRole"));
    let focused_pid = initial
        .as_ref()
        .ok()
        .map(|(el, _)| element_pid(*el).unwrap_or(0));
    if !needs_web_ax(role.as_deref())
        || !bootstrap_allowed(
            unsafe { AXIsProcessTrusted() } != 0,
            activation.is_some(),
            front,
            focused_pid,
        )
    {
        return initial;
    }
    let pid = front.unwrap(); // bootstrap_allowed requires a positive PID.
    let activation = activation.unwrap(); // Same strict host allowlist.
    let Ok(mut guard) = WEB_AX.try_lock() else {
        return initial;
    };
    let cache = guard.get_or_insert_with(HashSet::new);
    let mut aborted = false;
    let result = bootstrap_with(
        cache,
        pid,
        || {
            if host::frontmost_pid() != Some(pid) || unsafe { AXIsProcessTrusted() } == 0 {
                return false;
            }
            let app = unsafe { AXUIElementCreateApplication(pid) };
            if app.is_null() {
                return false;
            }
            if element_pid(app) != Some(pid) {
                release(app as CFTypeRef);
                return false;
            }
            let error = set_web_accessibility(app, activation);
            let enabled = error == AX_OK;
            release(app as CFTypeRef);
            enabled
        },
        || {
            if !bootstrap_still_allowed(
                &mut aborted,
                host::frontmost_pid() == Some(pid) && unsafe { AXIsProcessTrusted() } != 0,
            ) {
                return Err(
                    "Accessibility bootstrap aborted — foreground changed or permission denied"
                        .into(),
                );
            }
            let (el, name) = focused_ui_element_once(stage)?;
            let role = copy_string_attr(el, "AXRole");
            if element_pid(el) != Some(pid) || host::frontmost_pid() != Some(pid) {
                aborted = true;
                release(el as CFTypeRef);
                return Err("Accessibility bootstrap aborted — focused process changed".into());
            }
            if needs_web_ax(role.as_deref()) {
                release(el as CFTypeRef);
                return Err(
                    "Accessibility web focus still unavailable after initialization".into(),
                );
            }
            Ok((el, name))
        },
        || std::thread::sleep(std::time::Duration::from_millis(BOOTSTRAP_WAIT_MS)),
    );
    if let Some(result) = result {
        if let Ok((el, _)) = initial {
            release(el as CFTypeRef);
        }
        result
    } else {
        initial
    }
}

// Chromium and Electron debounce activation for two seconds. Allow a small
// readiness margin, without retrying activation or authorizing stale focus.
const BOOTSTRAP_READS: usize = 61;
const BOOTSTRAP_WAIT_MS: u64 = 40;

fn bootstrap_with<T, E>(
    cache: &mut HashSet<i32>,
    pid: i32,
    enable: impl FnOnce() -> bool,
    mut read: impl FnMut() -> Result<T, E>,
    mut wait: impl FnMut(),
) -> Option<Result<T, E>> {
    if !cache.contains(&pid) {
        if !enable() {
            return None;
        }
        cache.insert(pid);
    }
    for attempt in 0..BOOTSTRAP_READS {
        let result = read();
        if result.is_ok() || attempt + 1 == BOOTSTRAP_READS {
            return Some(result);
        }
        wait();
    }
    unreachable!()
}

fn bootstrap_allowed(
    trusted: bool,
    known_host: bool,
    front: Option<i32>,
    focus: Option<i32>,
) -> bool {
    trusted && known_host && front.is_some_and(|pid| pid > 0 && focus.is_none_or(|p| p == pid))
}

fn bootstrap_still_allowed(aborted: &mut bool, current_ok: bool) -> bool {
    *aborted |= !current_ok;
    !*aborted
}

#[cfg(test)]
mod bootstrap_tests {
    use super::*;

    #[test]
    fn bootstrap_waits_through_upstream_two_second_activation_debounce() {
        use std::cell::Cell;
        let elapsed = Cell::new(0);
        let mut cache = HashSet::new();
        let result = bootstrap_with(
            &mut cache,
            42,
            || true,
            || {
                if elapsed.get() >= 2_040 {
                    Ok(42)
                } else {
                    Err(-25212)
                }
            },
            || elapsed.set(elapsed.get() + BOOTSTRAP_WAIT_MS),
        );
        assert_eq!(result, Some(Ok(42)));
        assert!(elapsed.get() <= 2_400);
    }

    #[test]
    fn bootstrap_foreground_or_permission_loss_cannot_resume() {
        let mut aborted = false;
        assert!(bootstrap_still_allowed(&mut aborted, true));
        assert!(!bootstrap_still_allowed(&mut aborted, false));
        assert!(!bootstrap_still_allowed(&mut aborted, true));
    }

    #[test]
    fn bootstrap_requires_trust_known_host_and_independent_matching_pid() {
        assert!(bootstrap_allowed(true, true, Some(42), None));
        assert!(bootstrap_allowed(true, true, Some(42), Some(42)));
        assert!(!bootstrap_allowed(false, true, Some(42), None));
        assert!(!bootstrap_allowed(true, false, Some(42), None));
        assert!(!bootstrap_allowed(true, true, None, None));
        assert!(!bootstrap_allowed(true, true, Some(0), None));
        assert!(!bootstrap_allowed(true, true, Some(42), Some(43)));
    }

    #[test]
    fn bootstrap_enables_before_requery_and_waits_for_async_focus() {
        use std::cell::Cell;
        let enabled = Cell::new(false);
        let mut reads = 0;
        let mut waits = 0;
        let mut cache = HashSet::new();
        let result = bootstrap_with(
            &mut cache,
            42,
            || {
                enabled.set(true);
                true
            },
            || {
                assert!(enabled.get());
                reads += 1;
                if reads < 3 {
                    Err(-25212)
                } else {
                    Ok(42)
                }
            },
            || waits += 1,
        );
        assert_eq!(result, Some(Ok(42)));
        assert_eq!(reads, 3);
        assert_eq!(waits, 2);
        assert!(cache.contains(&42));
    }

    #[test]
    fn bootstrap_failed_enable_is_not_cached_or_requeried() {
        let mut cache = HashSet::new();
        let result: Option<Result<(), ()>> = bootstrap_with(
            &mut cache,
            42,
            || false,
            || panic!("failed initialization must not read"),
            || panic!("must not wait"),
        );
        assert!(result.is_none());
        assert!(cache.is_empty());
        assert_eq!(
            bootstrap_with(&mut cache, 42, || true, || Ok::<_, ()>(()), || {}),
            Some(Ok(()))
        );
    }

    #[test]
    fn bootstrap_cached_success_still_requeries_with_a_bound() {
        let mut cache = HashSet::from([42]);
        let mut reads = 0;
        let mut waits = 0;
        let result = bootstrap_with(
            &mut cache,
            42,
            || panic!("already enabled"),
            || {
                reads += 1;
                Err::<(), _>(-25212)
            },
            || waits += 1,
        );
        assert_eq!(result, Some(Err(-25212)));
        assert_eq!(reads, BOOTSTRAP_READS);
        assert_eq!(waits, BOOTSTRAP_READS - 1);
    }

    #[test]
    fn completion_returns_while_bootstrap_is_blocked_without_retargeting() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let (started_tx, started_rx) = channel();
        let (release_tx, release_rx) = channel();
        let (returned_tx, returned_rx) = channel();
        let caller = std::thread::spawn(move || {
            let initial = TargetSnapshotDto::unavailable("completion focus unavailable", 1);
            let snap = completion_snapshot_with(initial, move || {
                // Hold the real bootstrap cache throughout the blocked work.
                // The completion caller must remain independent of this lock.
                let _cache = WEB_AX.lock().unwrap();
                started_tx.send(std::thread::current().id()).unwrap();
                release_rx.recv().unwrap();
                TargetSnapshotDto::unavailable("later focus must not replace initial", 2001)
            });
            returned_tx
                .send((std::thread::current().id(), snap))
                .unwrap();
        });
        let warming_thread = started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let result = returned_rx.recv_timeout(Duration::from_secs(1));
        release_tx.send(()).unwrap();
        caller.join().unwrap();
        let (caller_thread, snap) = result.expect("UI/shortcut caller blocked on bootstrap");
        assert_ne!(warming_thread, caller_thread);
        assert_eq!(snap.captured_at, 1);
        assert_eq!(snap.reason.as_deref(), Some("completion focus unavailable"));
        assert!(!snap.insertable);
    }

    #[test]
    fn completion_snapshot_never_selects_focus_discovered_after_bootstrap_waits() {
        let initial = TargetSnapshotDto::unavailable("completion focus unavailable", 1);
        let (warmed_tx, warmed_rx) = std::sync::mpsc::channel();
        let snap = completion_snapshot_with(initial, move || {
            warmed_tx.send(()).unwrap();
            TargetSnapshotDto {
                app_name: None,
                app_pid: Some(42),
                captured_at: 2001,
                element_id: Some("C".into()),
                element_role: Some("AXTextField".into()),
                insertable: true,
                kind: "insertable".into(),
                reason: None,
            }
        });
        warmed_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("preserve host bootstrap for subsequent attempts");
        assert!(!snap.insertable);
        assert_eq!(snap.captured_at, 1);
        assert_eq!(snap.reason.as_deref(), Some("completion focus unavailable"));
    }

    #[test]
    fn completion_snapshot_with_known_field_does_not_wait_or_retarget() {
        let initial = TargetSnapshotDto {
            app_name: None,
            app_pid: Some(42),
            captured_at: 1,
            element_id: Some("B".into()),
            element_role: Some("AXTextField".into()),
            insertable: true,
            kind: "insertable".into(),
            reason: None,
        };
        let snap = completion_snapshot_with(initial, || {
            panic!("known completion field needs no bootstrap")
        });
        assert_eq!(snap.element_id.as_deref(), Some("B"));
    }

    #[test]
    fn bootstrap_missing_focus_does_not_require_an_ax_element() {
        assert!(needs_web_ax(None));
        assert!(needs_web_ax(Some("AXWebArea")));
        assert!(!needs_web_ax(Some("AXTextField")));
        assert!(!needs_web_ax(Some("AXSecureTextField")));
    }
}

/// Snapshot `element`; `register` retains it as the intended target.
pub fn build_snapshot(
    element: AXUIElementRef,
    app_name: Option<String>,
    register: bool,
) -> TargetSnapshotDto {
    let role = copy_string_attr(element, "AXRole").unwrap_or_else(|| "unknown".into());
    let pid = element_pid(element);
    let subrole = copy_string_attr(element, "AXSubrole");
    let (kind, insertable, reason) = classify_role(effective_role(&role, subrole.as_deref()));
    let generation = if register {
        registry::register(element)
    } else {
        registry::matching_generation(element)
    };
    let mut snap = TargetSnapshotDto {
        app_name,
        app_pid: pid,
        captured_at: now_ms(),
        element_id: Some(element_token(pid, &role, generation)),
        element_role: Some(role),
        insertable,
        kind: kind.into(),
        reason: reason.map(str::to_string),
    };
    if unsafe { AXIsProcessTrusted() } == 0 {
        snap.insertable = false;
        snap.kind = "unavailable".into();
        snap.reason = Some("Accessibility permission denied — insert skipped".into());
    }
    snap
}

fn completion_snapshot_with<T>(
    initial: TargetSnapshotDto,
    refresh: impl FnOnce() -> T + Send + 'static,
) -> TargetSnapshotDto {
    // The initial observation/registration happens synchronously, BEFORE any
    // worker scheduling. A busy worker must never move the selection boundary.
    // Warming is best-effort and cannot replace or register a later target.
    if !initial.insertable {
        let _ = std::thread::Builder::new()
            .name("web-ax-warm".into())
            .spawn(move || {
                drop(refresh());
            });
    }
    initial
}

pub fn snapshot_at(stage: &str, register: bool) -> TargetSnapshotDto {
    if unsafe { AXIsProcessTrusted() } == 0 {
        return TargetSnapshotDto::unavailable(
            &format!("Accessibility permission denied at {stage} — insert skipped"),
            now_ms(),
        );
    }
    if register {
        let front = host::frontmost_pid();
        let initial = snapshot_from_focus(focused_ui_element_once(stage), true);
        let stage = stage.to_owned();
        return completion_snapshot_with(initial, move || {
            // No snapshot building or registry access on this worker. Any
            // discovered element is released, never retained as a target.
            if let Ok((element, _)) = warm_web_ax(&stage, front) {
                release(element as CFTypeRef);
            }
        });
    }
    snapshot_from_focus(focused_ui_element(stage), false)
}

fn snapshot_from_focus(
    focus: Result<(AXUIElementRef, Option<String>), String>,
    register: bool,
) -> TargetSnapshotDto {
    match focus {
        Ok((element, app_name)) => {
            let snap = build_snapshot(element, app_name, register);
            release(element as CFTypeRef);
            snap
        }
        Err(msg) => TargetSnapshotDto::unavailable(&msg, now_ms()),
    }
}
