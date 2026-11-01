//! The generation guard and the delivery thread: a stale wake-up or edge is
//! dropped, and the sink never runs on the thread that queued the edge (so
//! it can never run inside the tap callback).

use super::delivery::{Delivery, Generations, Sink};
use super::machine::Edge;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(5);

fn recording_sink() -> (Sink, mpsc::Receiver<(Edge, thread::ThreadId)>) {
    let (tx, rx) = mpsc::channel();
    let sink: Sink = Box::new(move |edge| {
        let _ = tx.send((edge, thread::current().id()));
    });
    (sink, rx)
}

#[test]
fn generations_only_call_the_latest_one_current() {
    let live = Generations::default();
    let first = live.advance();
    assert!(live.is_current(first));
    let second = live.advance();
    assert!(
        !live.is_current(first),
        "re-arming retires the old listener"
    );
    assert!(live.is_current(second));
    live.advance(); // a disarm
    assert!(!live.is_current(second));
}

#[test]
fn generation_ids_never_repeat() {
    // The old guard compared addresses, which an allocator can reuse.
    let live = Generations::default();
    let ids: Vec<u64> = (0..1000).map(|_| live.advance()).collect();
    let mut sorted = ids.clone();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len());
    assert!(ids.windows(2).all(|w| w[0] < w[1]));
}

#[test]
fn edges_arrive_in_order_on_a_thread_other_than_the_caller() {
    let live = Generations::default();
    let generation = live.advance();
    let (sink, rx) = recording_sink();
    let delivery = Delivery::spawn(live, generation, sink).unwrap();
    delivery.send(vec![Edge::Pressed, Edge::Released, Edge::Cancelled]);
    let got: Vec<_> = (0..3).map(|_| rx.recv_timeout(WAIT).unwrap()).collect();
    let edges: Vec<Edge> = got.iter().map(|(edge, _)| *edge).collect();
    assert_eq!(edges, [Edge::Pressed, Edge::Released, Edge::Cancelled]);
    assert!(got.iter().all(|(_, id)| *id != thread::current().id()));
}

/// Everything the sink saw, once the delivery thread has ended (the sink, and
/// the sender it owns, is dropped then): no sleeping to prove a negative.
fn until_thread_ends(rx: &mpsc::Receiver<Edge>) -> Vec<Edge> {
    let mut seen = Vec::new();
    loop {
        match rx.recv_timeout(WAIT) {
            Ok(edge) => seen.push(edge),
            Err(mpsc::RecvTimeoutError::Disconnected) => return seen,
            Err(mpsc::RecvTimeoutError::Timeout) => panic!("delivery thread never ended"),
        }
    }
}

#[test]
fn an_edge_queued_before_a_re_arm_is_never_delivered() {
    let live = Generations::default();
    let old = live.advance();
    let (seen, rx) = mpsc::channel();
    let (entered_tx, entered) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    // The first edge parks the delivery thread inside the sink, so the second
    // is certainly still queued when the generation moves on.
    let sink: Sink = Box::new(move |edge| {
        let _ = seen.send(edge);
        if edge == Edge::Pressed {
            let _ = entered_tx.send(());
            let _ = released.recv_timeout(WAIT);
        }
    });
    let delivery = Delivery::spawn(live.clone(), old, sink).unwrap();
    delivery.send(vec![Edge::Pressed]);
    entered
        .recv_timeout(WAIT)
        .expect("the first edge reached the sink");
    delivery.send(vec![Edge::Released]);
    live.advance(); // re-arm (or disarm): the queued Released is now stale
    release.send(()).unwrap();
    drop(delivery);
    // Pressed was already in flight; Released must never reach the sink.
    assert_eq!(until_thread_ends(&rx), [Edge::Pressed]);
}

#[test]
fn a_sink_that_retires_its_own_listener_cannot_deadlock_or_get_later_edges() {
    // What a sink calling disarm would do: the generation moves on mid-edge.
    let live = Generations::default();
    let generation = live.advance();
    let (seen, rx) = mpsc::channel();
    let retire = live.clone();
    let sink: Sink = Box::new(move |edge| {
        let _ = seen.send(edge);
        retire.advance();
    });
    let delivery = Delivery::spawn(live, generation, sink).unwrap();
    delivery.send(vec![Edge::Pressed, Edge::Released, Edge::Cancelled]);
    assert_eq!(until_thread_ends(&rx), [Edge::Pressed]);
}
