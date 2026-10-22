import Foundation

/// Pinned and recently opened repositories, in a stable order so ⌘1–⌘9 keep pointing at the same repository.
///
/// Opening a repository that is already listed does not move it; a new repository is added at the
/// top of the recent list and the oldest recent entry beyond `limit` is dropped. Pinned repositories
/// come first, in the order they were pinned, and never count towards the limit.
public struct RecentRepositories: Equatable, Sendable {
    public static let defaultLimit = 12
    /// Number of entries that get a ⌘-number shortcut.
    public static let shortcutCount = 9

    public private(set) var pinned: [String]
    /// Recent repositories that are not pinned, newest first.
    public private(set) var paths: [String]
    public let limit: Int

    public init(paths: [String] = [], pinned: [String] = [], limit: Int = defaultLimit) {
        var seen = Set<String>()
        self.pinned = pinned.filter { seen.insert($0).inserted }
        self.paths = Array(paths.filter { seen.insert($0).inserted }.prefix(limit))
        self.limit = limit
    }

    /// Pinned first, then recent: the order of the sidebar and the ⌘-number shortcuts.
    public var all: [String] { pinned + paths }

    public func isPinned(_ path: String) -> Bool { pinned.contains(path) }

    /// Record an opened repository. Returns the paths that were dropped to stay within the limit.
    @discardableResult public mutating func open(_ path: String) -> [String] {
        guard !pinned.contains(path), !paths.contains(path) else { return [] }
        paths.insert(path, at: 0)
        return trim()
    }

    /// Add repositories used elsewhere (newest first) that are not listed yet, keeping their order
    /// above the existing recent entries. Returns the paths that were dropped to stay within the limit.
    @discardableResult public mutating func merge(_ used: [String]) -> [String] {
        var known = Set(all)
        let added = used.filter { known.insert($0).inserted }
        guard !added.isEmpty else { return [] }
        paths.insert(contentsOf: added, at: 0)
        return trim()
    }

    public mutating func remove(_ path: String) {
        pinned.removeAll { $0 == path }
        paths.removeAll { $0 == path }
    }

    /// Pin `path` after the other pinned repositories; it leaves the recent list.
    public mutating func pin(_ path: String) {
        guard !pinned.contains(path) else { return }
        paths.removeAll { $0 == path }
        pinned.append(path)
    }

    /// Move `path` back to the top of the recent list. Returns the paths that were dropped to stay within the limit.
    @discardableResult public mutating func unpin(_ path: String) -> [String] {
        guard pinned.contains(path) else { return [] }
        pinned.removeAll { $0 == path }
        paths.insert(path, at: 0)
        return trim()
    }

    public mutating func movePinned(fromOffsets source: IndexSet, toOffset destination: Int) {
        let moving = source.sorted().filter(pinned.indices.contains).map { pinned[$0] }
        let before = source.filter { $0 < destination }.count
        for index in source.sorted(by: >) where pinned.indices.contains(index) { pinned.remove(at: index) }
        pinned.insert(contentsOf: moving, at: min(max(destination - before, 0), pinned.count))
    }

    private mutating func trim() -> [String] {
        let dropped = Array(paths.dropFirst(limit))
        paths = Array(paths.prefix(limit))
        return dropped
    }
}

/// Reads the CLI's per-user record of repositories `yunbox` ran in, `repositories.json` beside
/// `blocked-pushes.json`. The app only reads it.
public enum UsedRepositories {
    public static let fileName = "repositories.json"

    public static func fileURL(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        BlockedPushes.fileURL(environment: environment, home: home)
            .deletingLastPathComponent().appending(path: fileName, directoryHint: .notDirectory)
    }

    /// Repository roots (standardized like the recent list) and when each was last used, newest first.
    /// Unknown versions read as empty; malformed entries are skipped.
    public static func decode(_ data: Data) -> [(path: String, usedAt: Date)] {
        guard let document = try? JSONDecoder().decode(Document.self, from: data), document.version == 1 else { return [] }
        let entries = document.entries.compactMap { raw -> (path: String, usedAt: Date)? in
            guard let root = raw.root, root.hasPrefix("/"), let at = raw.at.flatMap(BlockedPushes.parseDate) else { return nil }
            return (URL(fileURLWithPath: root).standardizedFileURL.path, at)
        }
        var seen = Set<String>()
        return entries.sorted { $0.usedAt > $1.usedAt }.filter { seen.insert($0.path).inserted }
    }

    /// Paths used after `since` that still exist, newest first, read from `url`; a missing file reads as empty.
    public static func load(
        from url: URL = fileURL(),
        since: Date?,
        exists: (String) -> Bool = BlockedPushes.directoryExists
    ) -> (paths: [String], latest: Date?) {
        guard let data = try? Data(contentsOf: url) else { return ([], nil) }
        let entries = decode(data)
        let fresh = entries.filter { entry in since.map { entry.usedAt > $0 } ?? true }
        return (fresh.map(\.path).filter(exists), entries.first?.usedAt)
    }

    private struct Document: Decodable {
        let version: Int
        let entries: [RawEntry]
    }

    private struct RawEntry: Decodable {
        let root: String?
        let at: String?

        private enum CodingKeys: String, CodingKey { case root, at }

        init(from decoder: Decoder) throws {
            let container = try? decoder.container(keyedBy: CodingKeys.self)
            root = try? container?.decodeIfPresent(String.self, forKey: .root)
            at = try? container?.decodeIfPresent(String.self, forKey: .at)
        }
    }
}
