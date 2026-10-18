use super::*;

pub(super) fn emit_terminal<E: Fn(SessionEvent)>(
    state: &Mutex<CoordinatorState>,
    generation: u64,
    request_id: &str,
    event: SessionEvent,
    emit: &E,
) {
    release_owned_reservation(state, generation, request_id);
    emit(event);
}

pub(super) fn emit_early_stop<E: Fn(SessionEvent)>(
    state: &Mutex<CoordinatorState>,
    generation: u64,
    request_id: &str,
    emit: &E,
) {
    emit_terminal(
        state,
        generation,
        request_id,
        SessionEvent::CaptureStopped {
            generation,
            request_id: request_id.to_owned(),
            audio: None,
        },
        emit,
    );
}
