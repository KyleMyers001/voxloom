use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

#[test]
fn cancellation_before_load_never_invokes_loader() {
    let flag = AtomicBool::new(true);
    let result: Result<(), _> =
        with_loaded_model(Some(&flag), || panic!("cancelled load"), |_: &()| Ok(()));
    assert_eq!(result.unwrap_err().code, "cancelled");
}

struct Context(Arc<AtomicBool>);
impl Drop for Context {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[test]
fn cancellation_during_load_skips_inference_and_drops_context() {
    let cancel = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered) = mpsc::channel();
    let (finish, finish_rx) = mpsc::channel();
    let flag = cancel.clone();
    let context_dropped = dropped.clone();
    let runner = std::thread::spawn(move || {
        with_loaded_model(
            Some(&flag),
            || {
                entered_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Ok(Context(context_dropped))
            },
            |_| -> Result<(), SttErrorDto> { panic!("inference after cancelled load") },
        )
    });
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    cancel.store(true, Ordering::SeqCst);
    assert!(
        !dropped.load(Ordering::SeqCst),
        "uninterruptible loader has not finished"
    );
    finish.send(()).unwrap();
    assert_eq!(runner.join().unwrap().unwrap_err().code, "cancelled");
    assert!(dropped.load(Ordering::SeqCst));
}

#[test]
fn cancellation_during_inference_suppresses_result_after_context_drop() {
    let cancel = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered) = mpsc::channel();
    let (finish, finish_rx) = mpsc::channel();
    let flag = cancel.clone();
    let context_dropped = dropped.clone();
    let runner = std::thread::spawn(move || {
        with_loaded_model(
            Some(&flag),
            || Ok(Context(context_dropped)),
            |_| {
                entered_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Ok("stale text")
            },
        )
    });
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    cancel.store(true, Ordering::SeqCst);
    finish.send(()).unwrap();
    assert_eq!(runner.join().unwrap().unwrap_err().code, "cancelled");
    assert!(dropped.load(Ordering::SeqCst));
}
