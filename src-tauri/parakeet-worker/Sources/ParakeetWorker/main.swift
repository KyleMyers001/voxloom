import Darwin
import LocalASR
import WorkerCore

// Only framed protocol bytes can reach the original stdout pipe.
do {
    let protocolFD = try WorkerHost.isolateProtocolOutput()
    await WorkerHost.run(load: FluidLocalLoader.load, outputFD: protocolFD)
    close(protocolFD)
} catch {
    _exit(1)
}
