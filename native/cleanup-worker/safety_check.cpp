#include "runtime_io.hpp"

#include <iostream>
#include <string>
#include <vector>

namespace {

void require(bool condition, const char * message) {
    if (!condition) throw std::runtime_error(message);
}

void rejects(const std::string & text, voxloom::Failure expected) {
    try {
        voxloom::validate_output(text);
    } catch (const voxloom::WorkerError & error) {
        require(error.failure() == expected, "wrong output failure");
        require(std::string(error.code()) == "invalid-output", "wrong code");
        return;
    }
    throw std::runtime_error("unsafe output accepted");
}

}  // namespace

int main(int argc, char ** argv) {
    try {
        if (argc == 3 && std::string(argv[1]) == "--model") {
            voxloom::require_model(argv[2]);
            return 0;
        }
        if (argc == 2 && std::string(argv[1]) == "--quiet") {
            voxloom::silence_stderr();
            std::cerr << "synthetic private prompt must not escape\n";
            return 0;
        }
        if (argc == 2 && std::string(argv[1]) == "--quiet-stdout") {
            try {
                const voxloom::QuietStdout quiet;
                std::cout << "synthetic private C++ log";
                std::printf("synthetic private C log");
                throw std::runtime_error("synthetic private exception");
            } catch (const std::exception &) {
            }
            std::cout << "restored\n";
            return 0;
        }
        for (const auto & text : std::vector<std::string>{
                 "", "hello\tworld\r\n", "café 日本語 😀",
                 "\xC2\x80", "\xDF\xBF", "\xE0\xA0\x80",
                 "\xED\x9F\xBF", "\xEE\x80\x80", "\xEF\xBF\xBF",
                 "\xF0\x90\x80\x80", "\xF4\x8F\xBF\xBF"}) {
            voxloom::validate_output(text);
        }
        for (const auto & text : std::vector<std::string>{
                 "\x80", "\xBF", "\xC0\xAF", "\xC1\xBF", "\xC2",
                 "\xC2\x20", "\xE0\x80\xAF", "\xE0\xA0",
                 "\xED\xA0\x80", "\xED\xBF\xBF", "\xEF\xBF",
                 "\xF0\x80\x80\xAF", "\xF0\x90\x80",
                 "\xF4\x90\x80\x80", "\xF5\x80\x80\x80",
                 "\xFF"}) {
            rejects(text, voxloom::Failure::invalid_utf8);
        }
        rejects("hello \xEF\xBF\xBD", voxloom::Failure::invalid_text);
        rejects(std::string("hello\0world", 11), voxloom::Failure::invalid_text);
        rejects("\x1B[31mhello", voxloom::Failure::invalid_text);
        rejects("hello\x7F", voxloom::Failure::invalid_text);
        voxloom::validate_output(std::string(32'000, 'x'));
        rejects(std::string(32'001, 'x'), voxloom::Failure::output_limit);
        // Token boundaries may bisect Unicode. Validate only the final bytes.
        voxloom::validate_output(std::string("\xF0\x9F") + "\x98\x80");
        for (auto failure : {voxloom::Failure::model_missing,
                             voxloom::Failure::context_overflow,
                             voxloom::Failure::invalid_utf8,
                             voxloom::Failure::invalid_text,
                             voxloom::Failure::output_limit,
                             voxloom::Failure::output_truncated,
                             voxloom::Failure::invalid_request,
                             voxloom::Failure::runtime}) {
            const voxloom::WorkerError error(failure);
            require(std::string(error.code()).size() <= 64, "unbounded code");
            require(std::string(error.what()).size() <= 1024, "unbounded error");
        }
        require(std::string(voxloom::WorkerError(
            voxloom::Failure::model_missing).code()) == "model-missing",
            "missing model must be intentional");
        require(std::string(voxloom::WorkerError(
            voxloom::Failure::context_overflow).code()) == "context-overflow",
            "overflow must be intentional");
        std::cout << "cleanup safety checks passed\n";
        return 0;
    } catch (const voxloom::WorkerError & error) {
        std::cerr << error.code() << ": " << error.what() << '\n';
        return 1;
    } catch (const std::exception &) {
        std::cerr << "cleanup safety check failed\n";
        return 1;
    }
}
