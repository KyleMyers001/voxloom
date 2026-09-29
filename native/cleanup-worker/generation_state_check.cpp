#include "generation_state.hpp"

#include <iostream>

int main() {
    voxloom::GenerationToken token;
    llama_batch first = token.batch(41);
    if (first.token != token.address() || *first.token != 41) {
        std::cerr << "generated token batch does not borrow stable storage\n";
        return 1;
    }
    llama_batch second = token.batch(42);
    if (second.token != first.token || *first.token != 42) {
        std::cerr << "generated token storage changed between decode steps\n";
        return 1;
    }
    std::cout << "generation token lifetime check passed\n";
    return 0;
}
