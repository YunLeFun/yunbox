import Foundation
import UniformTypeIdentifiers

/// How the detail pane can show a version.
public enum PreviewKind: Sendable, Equatable {
    case image, text, other
}

public enum ContentFailure: LocalizedError, Sendable {
    case invalidID, unavailable, diffFailed

    public var errorDescription: String? {
        switch self {
        case .invalidID: String(localized: "对象 ID 无效。")
        case .unavailable: String(localized: "这个版本不在本地：LFS 旧版本可能尚未下载，或仓库是部分克隆。")
        case .diffFailed: String(localized: "无法生成差异。")
        }
    }
}

/// Reads pushed versions by content ID: LFS payloads from the local LFS store, other files with
/// `git cat-file`. Never reads the worktree, which can differ from the pushed commits.
public struct ContentReader: Sendable {
    public let repository: URL
    let environment: [String: String]

    public init(repository: URL, environment: [String: String] = toolEnvironment()) {
        self.repository = repository
        // A missing old object must fail fast, not fetch from a partial clone's promisor remote.
        self.environment = environment.merging(["GIT_NO_LAZY_FETCH": "1", "GIT_OPTIONAL_LOCKS": "0"]) { _, new in new }
    }

    /// Write the version `oid` to `file`, unless an earlier export already did.
    public func export(oid: String, to file: URL) async throws {
        guard oid.wholeMatch(of: /[0-9a-f]{40}|[0-9a-f]{64}/) != nil else { throw ContentFailure.invalidID }
        let manager = FileManager.default
        if manager.fileExists(atPath: file.path) { return }
        try manager.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Write beside the target, then move: two rows exporting the same version never see half a file.
        let partial = file.deletingLastPathComponent().appending(path: ".partial-\(UUID().uuidString)")
        defer { try? manager.removeItem(at: partial) }
        if oid.count == 64, let store = try? await lfsObjects(),
           case let stored = store.appending(path: "\(oid.prefix(2))/\(oid.dropFirst(2).prefix(2))/\(oid)"),
           manager.fileExists(atPath: stored.path) {
            try manager.copyItem(at: stored, to: partial)
        } else {
            let output = try await git(["cat-file", "blob", oid], outputLimit: 512 * 1024 * 1024)
            guard output.exitCode == 0 else { throw ContentFailure.unavailable }
            try output.data.write(to: partial)
        }
        do {
            try manager.moveItem(at: partial, to: file)
        } catch where manager.fileExists(atPath: file.path) {}
    }

    /// Unified diff from the first hunk on; `nil` when Git treats either side as binary.
    public func diff(before: URL?, after: URL?) async throws -> String? {
        let output = try await git(["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--",
                                    before?.path ?? "/dev/null", after?.path ?? "/dev/null"], outputLimit: 16 * 1024 * 1024)
        // `--no-index` exits 1 when the files differ.
        guard output.exitCode == 0 || output.exitCode == 1 else { throw ContentFailure.diffFailed }
        let text = String(decoding: output.data, as: UTF8.self)
        if text.contains("\nBinary files ") || text.hasPrefix("Binary files ") { return nil }
        // The header names the temporary files; the pane shows the repository path instead.
        guard let hunk = text.range(of: "\n@@") else { return "" }
        return String(text[text.index(after: hunk.lowerBound)...])
    }

    /// `<common Git dir>/lfs/objects`, shared by all worktrees.
    func lfsObjects() async throws -> URL {
        let output = try await git(["rev-parse", "--git-common-dir"], outputLimit: 64 * 1024)
        let path = String(decoding: output.data, as: UTF8.self).trimmingCharacters(in: .newlines)
        guard output.exitCode == 0, !path.isEmpty else { throw ContentFailure.unavailable }
        let common = path.hasPrefix("/") ? URL(fileURLWithPath: path) : repository.appending(path: path, directoryHint: .isDirectory)
        return common.standardizedFileURL.appending(path: "lfs/objects", directoryHint: .isDirectory)
    }

    private func git(_ arguments: [String], outputLimit: Int) async throws -> ProcessRunner.Output {
        try await ProcessRunner.run(executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["git"] + arguments,
                                    directory: repository, environment: environment, timeout: 60, outputLimit: outputLimit)
    }

    /// How to show a file: images by type, text when the first 8000 bytes have no NUL (Git's own test).
    public static func kind(of file: URL, path: String) -> PreviewKind {
        if let type = UTType(filenameExtension: (path as NSString).pathExtension), type.conforms(to: .image) { return .image }
        guard let handle = try? FileHandle(forReadingFrom: file) else { return .other }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: 8000)) ?? Data()
        return head.contains(0) ? .other : .text
    }

    /// A Quick Look title for a version: `name（tag）.ext`, kept under the 255-byte file name limit.
    public static func fileName(for path: String, tag: String? = nil) -> String {
        var name = String(path.split(separator: "/", omittingEmptySubsequences: false).last ?? "")
        name = String(name.unicodeScalars.map { $0.properties.generalCategory == .control ? "_" : Character($0) })
        let dot = name.lastIndex(of: ".")
        let suffix = dot.map { String(name[$0...]) } ?? ""
        let hasExtension = (2...17).contains(suffix.count) && !suffix.dropFirst().contains(where: { $0 == "." || $0.isWhitespace })
        let fileExtension = hasExtension ? suffix : ""
        var stem = String(name.dropLast(fileExtension.count))
        while stem.utf8.count > 180 { stem.removeLast() }
        let result = stem + (tag.map { "（\($0)）" } ?? "") + fileExtension
        return result.isEmpty || result == "." || result == ".." ? "file\(result)" : result
    }
}

/// Environment for Git and the CLI: a usable PATH even when launched from Finder, no prompts,
/// and no Git overrides from a launching shell (the selected directory decides).
public func toolEnvironment(prepending directory: String? = nil) -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    let standardPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    environment["PATH"] = [directory, environment["PATH"], standardPath].compactMap { $0 }.joined(separator: ":")
    environment["GIT_TERMINAL_PROMPT"] = "0"
    for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] { environment.removeValue(forKey: key) }
    return environment
}
