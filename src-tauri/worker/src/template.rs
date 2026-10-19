//! Qwen3 ChatML with thinking off (the template's `enable_thinking=false`
//! form: an empty think block opens the reply). Same for every Qwen3 size.

/// Template text before the user prompt (special tokens parsed).
pub const PREFIX: &str = "<|im_start|>user\n";
/// Template text after the user prompt (special tokens parsed).
pub const SUFFIX: &str = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";

/// Output budget: about twice the prompt, plus a little slack.
pub fn max_new_tokens(prompt_tokens: usize) -> usize {
    prompt_tokens.saturating_mul(2).saturating_add(32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_the_prompt_as_one_user_turn_with_thinking_off() {
        let chat = format!("{PREFIX}fix this{SUFFIX}");
        assert_eq!(
            chat,
            "<|im_start|>user\nfix this<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
        );
    }

    #[test]
    fn output_budget_is_twice_the_prompt_plus_32() {
        assert_eq!(max_new_tokens(0), 32);
        assert_eq!(max_new_tokens(100), 232);
        assert_eq!(max_new_tokens(usize::MAX), usize::MAX);
    }
}
