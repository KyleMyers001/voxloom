use super::*;
use std::sync::Mutex;
use std::time::Duration;

#[test]
fn a_finished_run_loop_ends_the_loop_instead_of_spinning() {
    assert!(!run_again(RUN_FINISHED));
    // kCFRunLoopRunStopped, TimedOut, HandledSource: check `Stopping`.
    for result in [2, 3, 4] {
        assert!(run_again(result), "{result}");
    }
}

#[test]
fn a_finished_run_loop_is_lost_without_a_watchdog_check() {
    let mut checks = 0;
    let ended = drive(
        &Stopping::default(),
        || RUN_FINISHED,
        || {
            checks += 1;
            true
        },
    );
    assert_eq!(ended, Ended::Lost);
    assert_eq!(checks, 0);
}

#[test]
fn the_watchdog_runs_between_slices_and_can_end_the_loop() {
    let mut slices = 0;
    let mut checks = 0;
    let ended = drive(
        &Stopping::default(),
        || {
            slices += 1;
            3 // kCFRunLoopRunTimedOut
        },
        || {
            checks += 1;
            checks < 3
        },
    );
    assert_eq!(ended, Ended::Lost);
    assert_eq!((slices, checks), (3, 3));
}

#[test]
fn a_stop_during_a_slice_skips_the_watchdog() {
    let stopping = Stopping::default();
    let flag = stopping.clone();
    let ended = drive(
        &stopping,
        || {
            flag.0.store(true, Ordering::SeqCst);
            2 // kCFRunLoopRunStopped
        },
        || panic!("no check after the owner stopped"),
    );
    assert_eq!(ended, Ended::Stopped);
}

#[test]
fn stop_after_the_thread_already_ended_returns() {
    // The thread tore down on its own (finished run loop) before `stop`.
    let (ended_tx, ended) = mpsc::channel();
    let tap = spawn("t", move |ready, _| {
        ready.report(Ok(()));
        ended_tx.send(()).unwrap();
    })
    .unwrap();
    ended.recv().unwrap();
    let mut woken = false;
    tap.stop(|_| woken = true);
    assert!(woken);
}

#[test]
fn a_setup_error_is_returned_and_the_thread_ends() {
    let result = spawn::<()>("t", |ready, _| {
        ready.report(Err("no tap".into()));
    });
    assert_eq!(result.err().as_deref(), Some("no tap"));
}

#[test]
fn a_thread_that_never_reports_is_an_error_not_a_hang() {
    let result = spawn::<()>("t", |ready, _| drop(ready));
    assert!(result.is_err());
}

#[test]
fn stop_wakes_the_thread_and_waits_for_its_teardown() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&log);
    let tap = spawn("t", move |ready, stopping| {
        seen.lock().unwrap().push("listening");
        assert!(ready.report(Ok(7)));
        while !stopping.is_set() {
            thread::sleep(Duration::from_millis(1));
        }
        seen.lock().unwrap().push("torn down");
    })
    .unwrap();
    let mut woken = None;
    tap.stop(|handle| woken = Some(*handle));
    assert_eq!(woken, Some(7));
    assert_eq!(*log.lock().unwrap(), ["listening", "torn down"]);
}

#[test]
fn stop_from_the_tap_thread_returns_and_teardown_follows() {
    let slot: Arc<Mutex<Option<TapThread<()>>>> = Arc::default();
    let (done_tx, done) = mpsc::channel();
    let own = Arc::clone(&slot);
    let tap = spawn("t", move |ready, stopping| {
        ready.report(Ok(()));
        // Stand-in for a callback that disarms its own tap.
        let me = loop {
            if let Some(me) = own.lock().unwrap().take() {
                break me;
            }
            thread::sleep(Duration::from_millis(1));
        };
        me.stop(|_| {});
        assert!(stopping.is_set());
        done_tx.send("torn down").unwrap();
    })
    .unwrap();
    *slot.lock().unwrap() = Some(tap);
    let teardown = done.recv_timeout(Duration::from_secs(5));
    assert_eq!(teardown, Ok("torn down"));
}
