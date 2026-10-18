import Foundation

/// Runs outside the UI executor, drains stdout while running, and terminates on cancellation/timeout.
public enum ProcessRunner {
    public struct Output: Sendable {
        public let data: Data
        public let exitCode: Int32
    }

    public static func run(
        executable: URL, arguments: [String], directory: URL,
        environment: [String: String], timeout: TimeInterval = 120,
        outputLimit: Int = 64 * 1024 * 1024
    ) async throws -> Output {
        let controller = ProcessController()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    let process = Process()
                    let output = Pipe()
                    process.executableURL = executable
                    process.arguments = arguments
                    process.currentDirectoryURL = directory
                    process.environment = environment
                    process.standardInput = FileHandle.nullDevice
                    process.standardOutput = output
                    // CLI errors are structured on stdout. Never expose raw subprocess diagnostics/URLs.
                    process.standardError = FileHandle.nullDevice
                    do {
                        try controller.prepare(process)
                        try process.run()
                        controller.didStart()
                        let deadline = DispatchWorkItem { controller.stop(timedOut: true) }
                        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
                        defer { deadline.cancel() }
                        var data = Data()
                        var oversized = false
                        while let chunk = try output.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
                            if !oversized && data.count + chunk.count <= outputLimit {
                                data.append(chunk)
                            } else {
                                oversized = true
                                controller.stop()
                            }
                        }
                        process.waitUntilExit()
                        try output.fileHandleForReading.close()
                        if oversized { throw InspectionFailure.outputTooLarge }
                        try controller.check()
                        continuation.resume(returning: Output(data: data, exitCode: process.terminationStatus))
                    } catch {
                        controller.stop()
                        continuation.resume(throwing: error)
                    }
                }
            }
        } onCancel: {
            controller.stop()
        }
    }
}

/// Process itself is confined to a worker; the lock coordinates start/cancel races.
private final class ProcessController: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var stopped = false
    private var timedOut = false

    func prepare(_ process: Process) throws {
        lock.lock()
        defer { lock.unlock() }
        if stopped { throw CancellationError() }
        self.process = process
    }

    func didStart() {
        lock.lock()
        let shouldStop = stopped
        lock.unlock()
        if shouldStop { stop() }
    }

    func stop(timedOut: Bool = false) {
        lock.lock()
        self.timedOut = self.timedOut || (!stopped && timedOut)
        stopped = true
        let child = process
        lock.unlock()
        guard let child, child.isRunning else { return }
        child.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        }
    }

    func check() throws {
        lock.lock()
        defer { lock.unlock() }
        if timedOut { throw InspectionFailure.timedOut }
        if stopped { throw CancellationError() }
    }
}
