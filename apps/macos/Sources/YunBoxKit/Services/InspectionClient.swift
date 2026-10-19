import Foundation

public struct InspectionClient: Sendable {
    public let node: URL
    public let cli: URL

    public init(node: URL, cli: URL) {
        self.node = node
        self.cli = cli
    }

    public func inspect(repository: URL, limits: [String] = []) async throws -> InspectionResult {
        let output = try await ProcessRunner.run(
            executable: node,
            arguments: [cli.path, "inspect", "--push", "--json"] + limits,
            directory: repository, environment: environment()
        )
        return try InspectionResult.decode(output.data, exitCode: output.exitCode)
    }

    /// `yunbox doctor --json`: whether this repository can push and pull through YunBox.
    public func doctor(repository: URL) async throws -> DoctorReport {
        let output = try await ProcessRunner.run(
            executable: node, arguments: [cli.path, "doctor", "--json"],
            directory: repository, environment: environment(), timeout: 60
        )
        return try DoctorReport.decode(output.data, exitCode: output.exitCode)
    }

    /// `yunbox buckets --json` with this machine's keys.
    public func buckets(directory: URL) async throws -> [CosBucket] {
        let output = try await ProcessRunner.run(
            executable: node, arguments: [cli.path, "buckets", "--json"],
            directory: directory, environment: environment(), timeout: 60
        )
        return try BucketListing.decode(output.data)
    }

    /// `git yunbox init` for direct COS without questions; the window has already asked them.
    public func setUpCos(repository: URL, bucket: String, region: String, prefix: String, create: Bool) async throws -> CommandOutput {
        var arguments = [cli.path, "init", "--bucket", bucket, "--region", region, "--prefix", prefix, "--yes"]
        if create { arguments.append("--create") }
        return try await text(arguments: arguments, directory: repository, timeout: 120)
    }

    /// `yunbox login`; the SecretKey only travels on stdin, never in arguments.
    public func login(secretId: String, secretKey: String, directory: URL) async throws -> CommandOutput {
        try await text(
            arguments: [cli.path, "login", "--secret-id", secretId, "--secret-key-stdin"],
            directory: directory, timeout: 60, input: Data(secretKey.utf8)
        )
    }

    private func text(arguments: [String], directory: URL, timeout: TimeInterval, input: Data? = nil) async throws -> CommandOutput {
        let output = try await ProcessRunner.run(
            executable: node, arguments: arguments, directory: directory, environment: environment(),
            timeout: timeout, outputLimit: 1024 * 1024, input: input, mergeStandardError: true
        )
        return CommandOutput(exitCode: output.exitCode, text: String(decoding: output.data, as: UTF8.self))
    }

    /// Reads pushed versions of `repository` with the same Git the CLI uses.
    public func contentReader(repository: URL) -> ContentReader {
        ContentReader(repository: repository, environment: environment())
    }

    private func environment() -> [String: String] {
        toolEnvironment(prepending: node.deletingLastPathComponent().path)
    }

    public static func bundled(nodeOverride: String = "", bundle: Bundle = .main) throws -> InspectionClient {
        guard let resources = bundle.resourceURL else { throw InspectionFailure.missingCLI }
        let cli = resources.appending(path: "cli/cli.mjs")
        guard FileManager.default.fileExists(atPath: cli.path) else { throw InspectionFailure.missingCLI }
        struct Runtime: Decodable { let node: String }
        let runtime = try? Data(contentsOf: resources.appending(path: "runtime.json"))
        let configured = runtime.flatMap { try? JSONDecoder().decode(Runtime.self, from: $0) }?.node
        let path = ProcessInfo.processInfo.environment["PATH", default: ""].split(separator: ":").map { "\($0)/node" }
        let candidates = nodeOverride.isEmpty
            ? [configured].compactMap { $0 } + path + ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
            : [(nodeOverride as NSString).expandingTildeInPath]
        guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw InspectionFailure.missingNode
        }
        return InspectionClient(node: URL(fileURLWithPath: node), cli: cli)
    }
}
