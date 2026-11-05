import Darwin
import Foundation
import WorkerCore

private struct FixtureRecognizer: SpeechRecognizer {
    let mode: String
    func transcribe(_ samples: [Float]) async throws -> String {
        if mode == "inference-delay" || mode == "deadline-inference" {
            FileHandle.standardError.write(Data("inference\n".utf8))
            usleep(15_000_000)
        }
        return "fixture transcript"
    }
}

@main struct Fixture {
    // An unread full pipe makes the real protocol write block deterministically.
    // Unlike stdout's elastic pipe capacity, this cannot accidentally fit a reply.
    private static func blockedOutput() -> Int32 {
        var fds: [Int32] = [0, 0]
        precondition(pipe(&fds) == 0)
        let flags = fcntl(fds[1], F_GETFL)
        precondition(fcntl(fds[1], F_SETFL, flags | O_NONBLOCK) == 0)
        let bytes = [UInt8](repeating: 0, count: 4096)
        bytes.withUnsafeBytes { buffer in
            while Darwin.write(fds[1], buffer.baseAddress, buffer.count) > 0 {}
        }
        precondition(errno == EAGAIN)
        precondition(fcntl(fds[1], F_SETFL, flags) == 0)
        // Keep the read descriptor open and unread until process exit.
        FileHandle.standardError.write(Data("blocked-output\n".utf8))
        return fds[1]
    }

    static func main() async {
        let mode = CommandLine.arguments.dropFirst().first ?? "normal"
        let outputFD = mode == "noisy" ? (try! WorkerHost.isolateProtocolOutput()) : (mode == "deadline-write" ? blockedOutput() : STDOUT_FILENO)
        let limits = mode == "deadline-write" ? WorkerLimits(read: 15, load: 15, inference: 15, write: 0.15) :
            (mode.hasPrefix("deadline") ? WorkerLimits(read: 0.15, load: 0.15, inference: 0.15, write: 0.15) : WorkerLimits())
        await WorkerHost.run(load: { _ in
            if mode == "noisy" {
                print("PRIVATE SPEECH /private/model")
                fflush(nil)
                FileHandle.standardError.write(Data("PRIVATE SPEECH /private/model\n".utf8))
            }
            if mode == "load-delay" || mode == "deadline-load" {
                FileHandle.standardError.write(Data("loading\n".utf8))
                usleep(15_000_000)
            }
            return FixtureRecognizer(mode: mode)
        }, outputFD: outputFD, limits: limits)
    }
}
