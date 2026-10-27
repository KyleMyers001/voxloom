//! How many tokens one request may use: the output budget and the context
//! size. A pure function so the bounds are unit-tested (CR 3c-2 Low, the
//! E2/E3 mutants) instead of only through a real model.

use crate::error::WorkerError;
use crate::template::max_new_tokens;

#[derive(Debug, PartialEq, Eq)]
pub struct Sizing {
    /// Most reply tokens, as `output::collect` counts them.
    pub budget: usize,
    /// Context cells to allocate.
    pub n_ctx: u32,
}

/// `collect` makes up to `budget + 1` steps and each decodes the token it
/// sampled, so the context holds the prompt, the budget and one more token
/// (Codex 4318723345: without it the last step could decode past the end
/// and fail as a runtime error rather than reach the token limit).
pub fn size(prompt_tokens: usize, n_ctx_train: u32) -> Result<Sizing, WorkerError> {
    let budget = max_new_tokens(prompt_tokens);
    let needed = prompt_tokens.saturating_add(budget).saturating_add(1);
    if needed > n_ctx_train as usize {
        return Err(WorkerError::overflow(
            "prompt too long for the model context",
        ));
    }
    // Fits: n_ctx_train is a u32.
    let n_ctx = needed as u32;
    Ok(Sizing { budget, n_ctx })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overflow() -> WorkerError {
        WorkerError::overflow("prompt too long for the model context")
    }

    #[test]
    fn context_holds_the_prompt_the_budget_and_one_more_token() {
        let sizing = size(100, 40_960).unwrap();
        assert_eq!(
            sizing,
            Sizing {
                budget: 232,
                n_ctx: 333
            }
        );
    }

    #[test]
    fn the_codex_cases_get_room_for_the_last_step() {
        // 3n + 32 is a multiple of 256, so llama.cpp's rounding up of n_ctx
        // used to leave no spare cell for the final decode.
        assert_eq!(size(160, 40_960).unwrap().n_ctx, 513);
        assert_eq!(size(416, 40_960).unwrap().n_ctx, 1281);
    }

    #[test]
    fn exactly_the_training_context_fits_one_more_token_does_not() {
        assert_eq!(size(100, 333).unwrap().n_ctx, 333);
        assert_eq!(size(100, 332).unwrap_err(), overflow());
    }

    #[test]
    fn a_huge_prompt_is_an_overflow_not_a_wrap() {
        assert_eq!(size(usize::MAX, u32::MAX).unwrap_err(), overflow());
        // 3n + 33 just past usize::MAX: a wrapping sum would be tiny.
        assert_eq!(size(usize::MAX / 3 - 3, u32::MAX).unwrap_err(), overflow());
        let largest = (u32::MAX as usize - 33) / 3;
        assert!(size(largest, u32::MAX).is_ok());
        assert_eq!(size(largest + 1, u32::MAX).unwrap_err(), overflow());
    }
}
