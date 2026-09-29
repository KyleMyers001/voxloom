#include "chat.h"

#include <fstream>
#include <iostream>
#include <iterator>
#include <string>

int main(int argc, char ** argv) {
    if (argc != 2) {
        std::cerr << "usage: voxloom-template-check TEMPLATE\n";
        return 2;
    }
    std::ifstream input(argv[1]);
    if (!input) {
        std::cerr << "template unavailable\n";
        return 2;
    }
    const std::string source{
        std::istreambuf_iterator<char>(input),
        std::istreambuf_iterator<char>(),
    };
    auto templates = common_chat_templates_init(
        nullptr,
        source,
        "<|im_start|>",
        "<|im_end|>");
    if (!common_chat_templates_support_enable_thinking(templates.get())) {
        std::cerr << "template does not expose enable_thinking\n";
        return 1;
    }
    common_chat_templates_inputs inputs;
    inputs.enable_thinking = false;
    inputs.messages = {
        {"system", "Format conservatively."},
        {"user", "hello"},
    };
    const auto rendered =
        common_chat_templates_apply(templates.get(), inputs).prompt;
    const std::string expected =
        "<|im_start|>assistant\n<think>\n\n</think>\n\n";
    if (rendered.find(expected) == std::string::npos) {
        std::cerr << "non-thinking prefill missing\n";
        return 1;
    }
    std::cout << "Qwen3 non-thinking template check passed\n";
    return 0;
}
