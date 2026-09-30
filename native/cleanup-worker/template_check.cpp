#include "prompt_renderer.hpp"
#include "runtime_io.hpp"

#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <string>

namespace {

std::string render_file(const std::string & path) {
    std::ifstream input(path);
    if (!input) throw voxloom::WorkerError(voxloom::Failure::runtime);
    const std::string source{
        std::istreambuf_iterator<char>(input),
        std::istreambuf_iterator<char>(),
    };
    return voxloom::render_prompt(nullptr, "hello", source);
}

std::string render_model(const std::string & path) {
    // The opt-in Python wrapper verifies the allowlist and inherits this fd.
    // Direct use of this low-level checker does NOT establish artifact identity.
    voxloom::require_model(path);
    auto params = llama_model_default_params();
    params.vocab_only = true;
    params.n_gpu_layers = 0;
    std::unique_ptr<llama_model, decltype(&llama_model_free)> model(
        llama_model_load_from_file(path.c_str(), params), llama_model_free);
    if (!model) throw voxloom::WorkerError(voxloom::Failure::model_missing);
    return voxloom::render_prompt(model.get(), "hello");
}

}  // namespace

int main(int argc, char ** argv) {
    const bool actual_model = argc == 3 && std::string(argv[1]) == "--model";
    if (!actual_model && argc != 2) {
        std::cerr << "usage: voxloom-template-check TEMPLATE | --model MODEL\n";
        return 2;
    }
    try {
        voxloom::silence_stderr();
        std::string rendered;
        {
            const voxloom::QuietStdout quiet;
            rendered = actual_model ? render_model(argv[2]) : render_file(argv[1]);
        }
        const std::string expected =
            "<|im_start|>assistant\n<think>\n\n</think>\n\n";
        if (rendered.size() < expected.size()
            || rendered.compare(rendered.size() - expected.size(),
                                expected.size(), expected) != 0) {
            throw voxloom::WorkerError(voxloom::Failure::runtime);
        }
        std::cout << (actual_model ? "GGUF metadata" : "Weight-free source")
                  << " non-thinking template check passed\n";
        return 0;
    } catch (...) {
        std::cout << "Template check failed; verify model/template compatibility\n";
        return 1;
    }
}
