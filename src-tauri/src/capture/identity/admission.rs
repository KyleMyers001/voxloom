use std::sync::atomic::{AtomicU8, Ordering};

const ACTIVE: u8 = 1;
const IDLE: u8 = 0;
const QUARANTINED: u8 = 2;
static ADMISSION: AtomicU8 = AtomicU8::new(IDLE);

pub(super) fn quarantine() {
    ADMISSION.store(QUARANTINED, Ordering::SeqCst);
}

pub(super) fn release() {
    let _ = ADMISSION.compare_exchange(ACTIVE, IDLE, Ordering::SeqCst, Ordering::SeqCst);
}

pub(super) fn reserve() -> Result<(), String> {
    reserve_from(&ADMISSION)
}

fn reserve_from(admission: &AtomicU8) -> Result<(), String> {
    admission
        .compare_exchange(IDLE, ACTIVE, Ordering::SeqCst, Ordering::SeqCst)
        .map(|_| ())
        .map_err(|state| {
            let reason = if state == QUARANTINED {
                "identity monitor is quarantined"
            } else {
                "identity monitor is already active"
            };
            format!("capture-unavailable: {reason}")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quarantine_disables_every_later_admission() {
        let admission = AtomicU8::new(IDLE);
        let registrations = AtomicU8::new(0);
        assert!(reserve_from(&admission).is_ok());
        registrations.fetch_add(1, Ordering::SeqCst);
        assert!(reserve_from(&admission).is_err());
        admission.store(QUARANTINED, Ordering::SeqCst);
        assert!(reserve_from(&admission).is_err());
        assert!(reserve_from(&admission).is_err());
        assert_eq!(registrations.load(Ordering::SeqCst), 1);
    }
}
