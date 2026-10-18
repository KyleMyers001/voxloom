use super::*;

// Coordinator

pub(super) struct Reservation {
    pub(super) cancel: Arc<AtomicBool>,
    /// User stop: deposit + CaptureStopped (distinct from cancel/discard).
    pub(super) stop: Arc<AtomicBool>,
    pub(super) status: CaptureStatus,
}

pub(super) struct CoordinatorState {
    pub(super) cancelled_requests: VecDeque<String>,
    pub(super) reservation: Option<Reservation>,
}

/// Clears this request's reservation on worker-thread exit.
pub(super) struct PhaseGuard {
    pub(super) generation: u64,
    pub(super) request_id: String,
    pub(super) state: Arc<Mutex<CoordinatorState>>,
}

impl Drop for PhaseGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        let owns_reservation = state.reservation.as_ref().is_some_and(|reservation| {
            reservation.status.generation == self.generation
                && reservation.status.request_id == self.request_id
        });
        if owns_reservation {
            state.reservation = None;
        }
    }
}

pub(super) fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(super) fn is_cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Acquire)
}

pub(super) fn is_stopped(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Acquire)
}

pub(super) fn release_owned_reservation(
    state: &Mutex<CoordinatorState>,
    generation: u64,
    request_id: &str,
) {
    let mut state = state.lock().unwrap();
    let owns_reservation = state.reservation.as_ref().is_some_and(|reservation| {
        reservation.status.generation == generation && reservation.status.request_id == request_id
    });
    if owns_reservation {
        state.reservation = None;
    }
}
