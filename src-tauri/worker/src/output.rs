//! Collect generated pieces into the reply text, enforcing the caps.

use crate::error::WorkerError;

/// Matches the supervisor's output cap (supervisor/response.rs).
pub const MAX_OUTPUT_BYTES: usize = 32_000;

/// Pull up to `budget` pieces from `next` (`Ok(None)` = end of generation)
/// and return the trimmed text. Ending needs one more call after the last
/// piece, so a reply of exactly `budget` pieces still has room to stop.
pub fn collect(
    budget: usize,
    mut next: impl FnMut() -> Result<Option<Vec<u8>>, WorkerError>,
) -> Result<String, WorkerError> {
    let mut output = Vec::new();
    for _ in 0..=budget {
        let Some(piece) = next()? else {
            return finish(output);
        };
        output.extend(piece);
        if output.len() > MAX_OUTPUT_BYTES {
            return Err(WorkerError::output("cleanup output too long"));
        }
    }
    Err(WorkerError::token_limit())
}

fn finish(output: Vec<u8>) -> Result<String, WorkerError> {
    let text = String::from_utf8(output)
        .map_err(|_| WorkerError::output("cleanup output is not UTF-8"))?;
    let text = text.trim();
    if text.is_empty() {
        return Err(WorkerError::output("cleanup output is empty"));
    }
    Ok(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed `pieces`, then end of generation.
    fn run(budget: usize, pieces: &[&[u8]]) -> Result<String, WorkerError> {
        let mut pieces = pieces.iter().map(|piece| piece.to_vec());
        collect(budget, || Ok(pieces.next()))
    }

    #[test]
    fn joins_pieces_and_trims() {
        assert_eq!(
            run(8, &[b" Hello", b",", b" there. \n"]).unwrap(),
            "Hello, there."
        );
    }

    #[test]
    fn exactly_budget_pieces_then_end_is_ok() {
        assert_eq!(run(2, &[b"a", b"b"]).unwrap(), "ab");
    }

    #[test]
    fn one_piece_over_budget_is_the_token_limit() {
        let error = run(2, &[b"a", b"b", b"c"]).unwrap_err();
        assert_eq!(
            error,
            WorkerError::output("cleanup output reached the token limit")
        );
    }

    #[test]
    fn exactly_the_byte_cap_is_ok_one_more_byte_is_not() {
        // The literal, not the constant: it must equal the supervisor's cap.
        let full = vec![b'x'; 32_000];
        assert_eq!(run(4, &[&full]).unwrap().len(), 32_000);
        let error = run(4, &[&full, b"y"]).unwrap_err();
        assert_eq!(error, WorkerError::output("cleanup output too long"));
    }

    #[test]
    fn empty_or_blank_output_is_invalid() {
        let empty = WorkerError::output("cleanup output is empty");
        assert_eq!(run(4, &[]).unwrap_err(), empty);
        assert_eq!(run(4, &[b" \n", b"\t"]).unwrap_err(), empty);
    }

    #[test]
    fn non_utf8_output_is_invalid() {
        let error = run(4, &[b"\xff"]).unwrap_err();
        assert_eq!(error, WorkerError::output("cleanup output is not UTF-8"));
    }

    #[test]
    fn a_failed_step_is_returned() {
        let error = collect(4, || Err(WorkerError::runtime("output decode failed")));
        assert_eq!(
            error.unwrap_err(),
            WorkerError::runtime("output decode failed")
        );
    }
}
