import Foundation

public struct InspectionClient: Sendable {
    public let node: URL
    public let cli: URL

    public init(node: URL, cli: URL) {
        self.node = node
        self.cli = cli
    }

    public func inspect(repository: URL, limits: [String] = []) async throws -> InspectionResult {
        var environment = ProcessInfo.processInfo.environment
        let standardPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = "\(node.deletingLastPathComponent().path):\(environment["PATH"] ?? ""):\(standardPath)"
        environment["GIT_TERMINAL_PROMPT"] = "0"
        // A selected directory is authoritative, even if launched from a shell with Git overrides.
        for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] { environment.removeValue(forKey: key) }
        let output = try await ProcessRunner.run(
            executable: node,
            arguments: [cli.path, "inspect", "--push", "--json"] + limits,
            directory: repository, environment: environment
        )
        return try InspectionResult.decode(output.data, exitCode: output.exitCode)
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
