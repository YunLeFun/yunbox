import Foundation

/// Recently opened repositories, in a stable order so ⌘1–⌘9 keep pointing at the same repository.
///
/// Opening a repository that is already listed does not move it; a new repository is added at the
/// top and the oldest entry beyond `limit` is dropped.
public struct RecentRepositories: Equatable, Sendable {
    public static let defaultLimit = 12
    /// Number of entries that get a ⌘-number shortcut.
    public static let shortcutCount = 9

    public private(set) var paths: [String]
    public let limit: Int

    public init(paths: [String] = [], limit: Int = defaultLimit) {
        var seen = Set<String>()
        self.paths = Array(paths.filter { seen.insert($0).inserted }.prefix(limit))
        self.limit = limit
    }

    /// Record an opened repository. Returns the paths that were dropped to stay within the limit.
    @discardableResult public mutating func open(_ path: String) -> [String] {
        guard !paths.contains(path) else { return [] }
        paths.insert(path, at: 0)
        let dropped = Array(paths.dropFirst(limit))
        paths = Array(paths.prefix(limit))
        return dropped
    }

    public mutating func remove(_ path: String) {
        paths.removeAll { $0 == path }
    }
}
