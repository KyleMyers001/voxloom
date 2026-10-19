//! Qwen3 ChatML. Hybrid-thinking checkpoints (Qwen3 0.6B/1.7B/4B/8B…) get
//! the template's `enable_thinking=false` form: an empty think block opens
//! the reply. Instruct-only checkpoints (e.g. Qwen3-4B-Instruct-2507) have no
//! thinking mode and no think block in their template, so they get none.

/// Template text before the user prompt (special tokens parsed).
pub const PREFIX: &str = "<|im_start|>user\n";
const ASSISTANT: &str = "<|im_end|>\n<|im_start|>assistant\n";
const ASSISTANT_NO_THINK: &str = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";

/// Template text after the user prompt, given the GGUF's own chat template
/// (`tokenizer.chat_template`; `None` when the file has none).
pub fn suffix(model_template: Option<&str>) -> &'static str {
    match model_template {
        Some(template) if !template.contains("enable_thinking") => ASSISTANT,
        _ => ASSISTANT_NO_THINK,
    }
}

/// Output budget: about twice the prompt, plus a little slack.
pub fn max_new_tokens(prompt_tokens: usize) -> usize {
    prompt_tokens.saturating_mul(2).saturating_add(32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HYBRID: &str = "{%- if enable_thinking is defined and enable_thinking is false %}";

    #[test]
    fn hybrid_qwen3_gets_one_user_turn_with_thinking_off() {
        let chat = format!("{PREFIX}fix this{}", suffix(Some(HYBRID)));
        assert_eq!(
            chat,
            "<|im_start|>user\nfix this<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
        );
        assert_eq!(suffix(None), ASSISTANT_NO_THINK);
    }

    #[test]
    fn instruct_only_qwen3_gets_no_think_block() {
        let chat = format!(
            "{PREFIX}fix this{}",
            suffix(Some("{{- '<|im_start|>' + message.role }}"))
        );
        assert_eq!(
            chat,
            "<|im_start|>user\nfix this<|im_end|>\n<|im_start|>assistant\n"
        );
    }

    #[test]
    fn output_budget_is_twice_the_prompt_plus_32() {
        assert_eq!(max_new_tokens(0), 32);
        assert_eq!(max_new_tokens(100), 232);
        assert_eq!(max_new_tokens(usize::MAX), usize::MAX);
    }
}
