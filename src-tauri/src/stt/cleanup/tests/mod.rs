//! BUS-23 cleanup unit tests.

use super::lists::SILENCE_HALLUCINATIONS;
use super::*;

mod hallucinations;
mod tag_variants;
mod tidy_and_symbols;

/// Clean a loud (non-quiet) clip with default options.
fn loud(raw: &str) -> String {
    clean_transcript(
        raw,
        CleanupOptions {
            quiet: false,
            strip_outros: true,
        },
    )
    .text
}

/// Clean a quiet clip with default options.
fn quiet(raw: &str) -> Cleaned {
    clean_transcript(
        raw,
        CleanupOptions {
            quiet: true,
            strip_outros: true,
        },
    )
}
