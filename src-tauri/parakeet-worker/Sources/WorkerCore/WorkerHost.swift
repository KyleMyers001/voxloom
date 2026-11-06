import Darwin
import Foundation

private enum InputEnd: Error { case eof }

private struct NativeInput: Sendable {
    let fd: Int32
    func exact(_ count: Int) throws -> Data {
        var data = Data(count: count)
        try data.withUnsafeMutableBytes { bytes in
            var offset = 0
            while offset < count {
                let received = Darwin.read(fd, bytes.baseAddress!.advanced(by: offset), count - offset)
                if received == 0 { throw InputEnd.eof }
                if received < 0 {
                    if errno == EINTR { continue }
                    throw WorkerFailure.engineUnavailable
                }
                offset += received
            }
        }
        return data
    }
    func frame() throws -> Data {
        let prefix = try exact(4)
        let count = prefix.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
        guard count > 0, count <= Wire.maxControlBytes else { throw WorkerFailure.engineUnavailable }
        return try exact(Int(count))
    }
}

public struct WorkerLimits: Sendable {
    public let read: Double
    public let load: Double
    public let inference: Double
    public let write: Double
    public init(read: Double = 180, load: Double = 120, inference: Double = 120, write: Double = 5) {
        self.read = read; self.load = load; self.inference = inference; self.write = write
    }
}

/// Independent of Swift tasks and Core ML, including synchronous compilation.
private final class ProcessDeadline: @unchecked Sendable {
    private let queue = DispatchQueue(label: "voxloom.parakeet.deadline")
    private let timer: DispatchSourceTimer
    init(seconds: Double) {
        timer = DispatchSource.makeTimerSource(queue: queue)
        timer.setEventHandler { _exit(1) }
        timer.schedule(deadline: .now() + seconds)
        timer.resume()
    }
    func arm(_ seconds: Double) { queue.sync { timer.schedule(deadline: .now() + seconds) } }
    func cancel() { queue.sync { timer.cancel() } }
}

public enum WorkerHost {
    /// Reserve a protocol-only descriptor, then discard dependency/framework console
    /// output. Call before constructing models; never route third-party logs to IPC.
    public static func isolateProtocolOutput() throws -> Int32 {
        let protocolFD = dup(STDOUT_FILENO)
        guard protocolFD >= 0 else { throw WorkerFailure.engineUnavailable }
        let nullFD = open("/dev/null", O_WRONLY)
        guard nullFD >= 0 else { close(protocolFD); throw WorkerFailure.engineUnavailable }
        defer { close(nullFD) }
        guard dup2(nullFD, STDOUT_FILENO) >= 0, dup2(nullFD, STDERR_FILENO) >= 0 else {
            close(protocolFD)
            throw WorkerFailure.engineUnavailable
        }
        return protocolFD
    }

    public static func run(load: WorkerSession.Loader, inputFD: Int32 = STDIN_FILENO, outputFD: Int32 = STDOUT_FILENO,
                           limits: WorkerLimits = WorkerLimits()) async {
        signal(SIGPIPE, SIG_IGN)
        let deadline = ProcessDeadline(seconds: limits.read)
        defer { deadline.cancel() }
        let pair = AsyncStream<WorkerInput>.makeStream(bufferingPolicy: .bufferingOldest(2))
        Thread.detachNewThread {
            let reader = NativeInput(fd: inputFD)
            var failure = WorkerFailure.engineUnavailable
            do {
                let header = try Wire.load(reader.frame())
                pair.continuation.yield(.load(header))
                failure = .unsupportedAudio
                let audio = try Wire.audioHeader(reader.frame(), requestId: header.requestId)
                let samples = try Wire.samples(reader.exact(audio.sampleCount * 4), count: audio.sampleCount)
                pair.continuation.yield(.audio(samples, vocabulary: audio.vocabulary))
            } catch is InputEnd {
                // Core ML has no reliable cooperative cancellation. Terminate the
                // process from this independent reader even while load/predict blocks.
                _exit(0)
            } catch {
                pair.continuation.yield(.failure(failure))
            }
            pair.continuation.finish()
            // One recording only. Keep watching ownership after the final PCM byte.
            // A second request/trailing byte is forbidden; EOF drops in-flight work.
            do { _ = try reader.exact(1); _exit(1) }
            catch is InputEnd { _exit(0) }
            catch { _exit(1) }
        }
        await WorkerSession.run(input: pair.stream, load: load, send: { data in
            let frame = try Wire.frame(data)
            try frame.withUnsafeBytes { bytes in
                var offset = 0
                while offset < bytes.count {
                    let sent = Darwin.write(outputFD, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                    if sent < 0, errno == EINTR { continue }
                    guard sent > 0 else { throw WorkerFailure.engineUnavailable }
                    offset += sent
                }
            }
        }, phase: { phase in
            switch phase {
            case .loading: deadline.arm(limits.load)
            case .awaitingAudio: deadline.arm(limits.read)
            case .transcribing: deadline.arm(limits.inference)
            case .writing: deadline.arm(limits.write)
            }
        })
    }
}
