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

    /// `git yunbox init` for S3-compatible storage (R2, AWS S3, MinIO …) in an existing bucket.
    public func setUpS3(repository: URL, setup: S3Setup) async throws -> CommandOutput {
        try await text(arguments: [cli.path, "init"] + setup.initArguments, directory: repository, timeout: 120)
    }

    /// `yunbox login [--provider s3]`; the SecretKey / Secret Access Key only travels on stdin, never in arguments.
    public func login(provider: StorageProvider = .cos, secretId: String, secretKey: String, directory: URL) async throws -> CommandOutput {
        try await text(
            arguments: [cli.path, "login"] + provider.loginArguments + ["--secret-id", secretId, "--secret-key-stdin"],
            directory: directory, timeout: 60, input: Data(secretKey.utf8)
        )
    }

    /// `git yunbox types --json`: which asset types go through LFS and which assets were committed as ordinary files.
    public func assetTypes(repository: URL) async throws -> AssetTypesReport {
        let output = try await ProcessRunner.run(
            executable: node, arguments: [cli.path, "types", "list", "--json"],
            directory: repository, environment: environment(), timeout: 60
        )
        return try AssetTypesReport.decode(output.data, exitCode: output.exitCode)
    }

    /// `git yunbox types add`: append the LFS rules of these types or presets; with `renormalize`, also stage the
    /// committed files they catch so the next commit stores them as LFS pointers.
    public func addAssetTypes(repository: URL, ids: [String], renormalize: Bool = false) async throws -> CommandOutput {
        try await text(arguments: [cli.path, "types", "add"] + ids + (renormalize ? ["--renormalize"] : []), directory: repository, timeout: 120)
    }

    /// `git yunbox types remove`: delete the rules YunBox generated for these types.
    public func removeAssetTypes(repository: URL, ids: [String]) async throws -> CommandOutput {
        try await text(arguments: [cli.path, "types", "remove"] + ids, directory: repository, timeout: 60)
    }

    /// `yunbox freeze list --json`: windows, the current verdict and the pre-push wrapper. `directory` need not be a repository.
    public func freezeStatus(directory: URL) async throws -> FreezeStatus {
        let output = try await ProcessRunner.run(
            executable: node, arguments: [cli.path, "freeze", "list", "--json"],
            directory: directory, environment: environment(), timeout: 30, mergeStandardError: true
        )
        return try FreezeStatus.decode(output.data, exitCode: output.exitCode)
    }

    /// `yunbox freeze set`: replace `scope`'s windows; a `nil` message or time zone leaves the stored one, `""` removes it.
    public func setFreeze(directory: URL, rules: [String], scope: FreezeStatus.Scope, message: String?, timeZone: String?) async throws -> CommandOutput {
        var arguments = [cli.path, "freeze", "set"] + rules + (scope.flag ?? [])
        if let message { arguments += ["--message", message] }
        if let timeZone { arguments += ["--timezone", timeZone] }
        return try await text(arguments: arguments, directory: directory, timeout: 30)
    }

    /// `yunbox freeze clear` for one scope.
    public func clearFreeze(directory: URL, scope: FreezeStatus.Scope) async throws -> CommandOutput {
        try await text(arguments: [cli.path, "freeze", "clear"] + (scope.flag ?? []), directory: directory, timeout: 30)
    }

    /// `yunbox freeze off`: switch every window off for this repository (`.local`) or the machine (`.global`).
    public func pauseFreeze(directory: URL, scope: FreezeStatus.Scope, option: FreezePauseOption) async throws -> CommandOutput {
        try await text(arguments: [cli.path, "freeze", "off"] + option.arguments + (scope == .global ? ["--global"] : []), directory: directory, timeout: 30)
    }

    /// `yunbox freeze on`: end a pause early.
    public func resumeFreeze(directory: URL, scope: FreezeStatus.Scope) async throws -> CommandOutput {
        try await text(arguments: [cli.path, "freeze", "on"] + (scope == .global ? ["--global"] : []), directory: directory, timeout: 30)
    }

    /// `yunbox hook install`: the pre-push wrapper that enforces freeze windows and size limits.
    public func installHook(repository: URL, globally: Bool = false, confirm: Bool = true, compatible: Bool = false, confirmAlways: Bool = false) async throws -> CommandOutput {
        let confirmation = confirm ? ["--confirm-mode", confirmAlways ? "always" : "exceeded"] : ["--no-confirm"]
        return try await text(arguments: [cli.path, "hook", "install"] + confirmation + (globally ? ["--global"] : compatible ? ["--compatible"] : []), directory: repository, timeout: 30)
    }

    /// Reattach the current team hook directory after another tool replaces the local setting.
    public func repairHook(repository: URL, confirm: Bool = true, confirmAlways: Bool = false) async throws -> CommandOutput {
        let confirmation = confirm ? ["--confirm-mode", confirmAlways ? "always" : "exceeded"] : ["--no-confirm"]
        return try await text(arguments: [cli.path, "hook", "repair"] + confirmation, directory: repository, timeout: 30)
    }

    /// Restore the original local configuration, preserving any later changes made by the user.
    public func uninstallHook(repository: URL) async throws -> CommandOutput {
        try await text(arguments: [cli.path, "hook", "uninstall"], directory: repository, timeout: 30)
    }

    /// Explicitly clear a missing local path; inherited paths and active dispatchers are retained.
    public func clearMissingHook(repository: URL) async throws -> CommandOutput {
        try await text(arguments: [cli.path, "hook", "clear-missing"], directory: repository, timeout: 30)
    }

    /// Read prerequisites and whether this repository is protected, without modifying Git configuration.
    public func hookStatus(directory: URL) async throws -> HookStatus {
        let output = try await ProcessRunner.run(
            executable: node, arguments: [cli.path, "hook", "status", "--json"],
            directory: directory, environment: environment(), timeout: 30
        )
        return try HookStatus.decode(output.data, exitCode: output.exitCode)
    }

    /// Remove only YunBox's managed global dispatcher; repository hooks are kept.
    public func uninstallGlobalHook(directory: URL) async throws -> CommandOutput {
        try await text(arguments: [cli.path, "hook", "uninstall", "--global"], directory: directory, timeout: 30)
    }

    /// Read all local protection decisions, including user-confirmed continuations.
    public func pushHistory() async throws -> PushHistoryReport {
        let output = try await ProcessRunner.run(
            executable: node, arguments: [cli.path, "history", "--all", "--json"],
            directory: FileManager.default.homeDirectoryForCurrentUser, environment: environment(), timeout: 15
        )
        return try PushHistoryReport.decode(output.data, exitCode: output.exitCode)
    }

    /// The UI confirms the chosen scope before this command is called. Deleted project directories work too.
    public func clearPushHistory(project: String?) async throws -> PushHistoryReport {
        let scope = project.map { ["--project", $0] } ?? ["--all"]
        let output = try await ProcessRunner.run(
            executable: node, arguments: [cli.path, "history", "clear", "--yes", "--json"] + scope,
            directory: FileManager.default.homeDirectoryForCurrentUser, environment: environment(), timeout: 15
        )
        // Return all projects, so clearing one project does not remove other projects from the picker.
        _ = try PushHistoryReport.decode(output.data, exitCode: output.exitCode)
        return try await pushHistory()
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
