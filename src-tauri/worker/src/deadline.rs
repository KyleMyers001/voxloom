//! Cap the reply by the time left (BUS-16 3c-2c). The app sends how long the
//! worker has; at the start of decoding the worker turns what is left into a
//! token cap. Hitting that cap is a timeout, not an invalid reply, so the app
//! reports it like its own timeout and keeps the raw text. The app's timer
//! still decides; this only stops the worker before it is killed.

use std::time::{Duration, Instant};

use crate::error::WorkerError;

/// Provisional: decode speed assumed for the cap. 22 tokens/s is Qwen3-1.7B
/// on a base M2 (/workspace/pr3c-design.md); tuned on 1.7B after BUS-114 and
/// the Build C Mac timings. On 0.6B, which decodes faster, the cap is
/// conservative.
pub const PROVISIONAL_TOKENS_PER_SECOND: u64 = 22;

/// Provisional: time kept back for the reply frame, the app's checks and
/// delivery.
pub const REPLY_MARGIN: Duration = Duration::from_millis(300);

/// The token limit for one reply, and whether time set it.
#[derive(Debug, PartialEq, Eq)]
pub struct Limit {
    pub tokens: usize,
    pub by_time: bool,
}

/// `budget` from the prompt size, lowered to what fits before `deadline`.
pub fn limit(budget: usize, deadline: Option<Instant>, now: Instant) -> Limit {
    let Some(deadline) = deadline else {
        return Limit {
            tokens: budget,
            by_time: false,
        };
    };
    let left = deadline
        .saturating_duration_since(now)
        .saturating_sub(REPLY_MARGIN);
    let fits = left
        .as_millis()
        .saturating_mul(PROVISIONAL_TOKENS_PER_SECOND.into())
        / 1000;
    let fits = usize::try_from(fits).unwrap_or(usize::MAX);
    if fits < budget {
        Limit {
            tokens: fits,
            by_time: true,
        }
    } else {
        Limit {
            tokens: budget,
            by_time: false,
        }
    }
}

impl Limit {
    /// The error to report: reaching a cap that time set is a timeout.
    pub fn explain(&self, error: WorkerError) -> WorkerError {
        if self.by_time && error == WorkerError::token_limit() {
            WorkerError::timeout()
        } else {
            error
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64) -> (Option<Instant>, Instant) {
        let now = Instant::now();
        (Some(now + Duration::from_millis(ms)), now)
    }

    #[test]
    fn without_a_deadline_the_budget_stands() {
        let limit = limit(232, None, Instant::now());
        assert_eq!(
            limit,
            Limit {
                tokens: 232,
                by_time: false
            }
        );
    }

    #[test]
    fn the_time_left_less_the_margin_sets_the_cap() {
        // 5.3 s - 0.3 s = 5 s at 22 tokens/s.
        let (deadline, now) = at(5_300);
        assert_eq!(
            limit(1_000, deadline, now),
            Limit {
                tokens: 110,
                by_time: true
            }
        );
    }

    #[test]
    fn a_smaller_budget_wins_and_is_not_a_timeout() {
        let (deadline, now) = at(5_300);
        assert_eq!(
            limit(110, deadline, now),
            Limit {
                tokens: 110,
                by_time: false
            }
        );
        assert_eq!(
            limit(109, deadline, now),
            Limit {
                tokens: 109,
                by_time: false
            }
        );
        assert_eq!(
            limit(111, deadline, now),
            Limit {
                tokens: 110,
                by_time: true
            }
        );
    }

    #[test]
    fn past_the_deadline_or_inside_the_margin_nothing_fits() {
        let (deadline, now) = at(300);
        assert_eq!(
            limit(50, deadline, now),
            Limit {
                tokens: 0,
                by_time: true
            }
        );
        let late = now + Duration::from_secs(1);
        assert_eq!(
            limit(50, deadline, late),
            Limit {
                tokens: 0,
                by_time: true
            }
        );
    }

    #[test]
    fn only_a_time_cap_turns_the_token_limit_into_a_timeout() {
        let by_time = Limit {
            tokens: 3,
            by_time: true,
        };
        let by_size = Limit {
            tokens: 3,
            by_time: false,
        };
        assert_eq!(
            by_time.explain(WorkerError::token_limit()),
            WorkerError::timeout()
        );
        assert_eq!(
            by_size.explain(WorkerError::token_limit()),
            WorkerError::token_limit()
        );
        let other = WorkerError::output("cleanup output too long");
        assert_eq!(
            by_time.explain(other),
            WorkerError::output("cleanup output too long")
        );
    }
}
