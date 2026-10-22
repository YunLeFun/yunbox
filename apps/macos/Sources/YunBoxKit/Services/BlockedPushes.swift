import Foundation

/// A push the pre-push hook stopped, as the CLI recorded it in `blocked-pushes.json`.
public struct BlockedPush: Equatable, Sendable, Identifiable {
    /// Why the push was stopped.
    public enum Reason: String, Sendable {
        /// A push freeze window was in effect.
        case freeze
        /// A budget was exceeded and nobody could be asked.
        case exceeded
        /// A budget was exceeded and the user chose “cancel” in the confirmation.
        case cancelled
    }

    /// Repository root, standardized like the paths of the recent list.
    public let path: String
    public let blockedAt: Date
    public let reason: Reason
    /// The CLI's short explanation, e.g. the window or the exceeded budgets (Chinese).
    public let summary: String

    public var id: String { path }

    public init(path: String, blockedAt: Date, reason: Reason, summary: String) {
        self.path = path
        self.blockedAt = blockedAt
        self.reason = reason
        self.summary = summary
    }
}

/// Reads the CLI's per-user record of recently blocked pushes.
///
/// The CLI keeps one entry per repository, newest first, in `blocked-pushes.json` beside its
/// credentials file. The app only reads it; hiding an entry is remembered on the app side.
public enum BlockedPushes {
    public static let fileName = "blocked-pushes.json"
    /// Entries older than this are no longer “recent”.
    public static let maxAge: TimeInterval = 14 * 24 * 60 * 60
    public static let defaultLimit = 5

    /// The CLI's config directory: `$YUNBOX_CONFIG_DIR`, else `$XDG_CONFIG_HOME/yunbox`, else `~/.config/yunbox`.
    public static func fileURL(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        let directory: URL
        if let custom = environment["YUNBOX_CONFIG_DIR"], !custom.isEmpty {
            directory = URL(fileURLWithPath: custom, isDirectory: true)
        } else if let xdg = environment["XDG_CONFIG_HOME"], !xdg.isEmpty {
            directory = URL(fileURLWithPath: xdg, isDirectory: true).appending(path: "yunbox", directoryHint: .isDirectory)
        } else {
            directory = home.appending(path: ".config/yunbox", directoryHint: .isDirectory)
        }
        return directory.appending(path: fileName, directoryHint: .notDirectory)
    }

    /// Entries of a record, newest first. Unknown versions read as empty; malformed entries are skipped.
    public static func decode(_ data: Data) -> [BlockedPush] {
        guard let document = try? JSONDecoder().decode(Document.self, from: data), document.version == 1 else { return [] }
        let entries = document.entries.compactMap { raw -> BlockedPush? in
            guard let root = raw.root, root.hasPrefix("/"),
                  let reason = raw.reason.flatMap(BlockedPush.Reason.init(rawValue:)),
                  let at = raw.at.flatMap(parseDate) else { return nil }
            return BlockedPush(path: URL(fileURLWithPath: root).standardizedFileURL.path, blockedAt: at, reason: reason, summary: raw.summary ?? "")
        }
        var seen = Set<String>()
        return entries.sorted { $0.blockedAt > $1.blockedAt }.filter { seen.insert($0.path).inserted }
    }

    /// Read the record at `url`; a missing or unreadable file reads as empty.
    public static func load(from url: URL = fileURL()) -> [BlockedPush] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return decode(data)
    }

    /// The entries worth showing: blocked within `maxAge` of `now`, not hidden since (`dismissed` maps a
    /// path to when it was hidden; a newer block shows it again), still on disk, at most `limit`.
    public static func recent(
        _ entries: [BlockedPush],
        now: Date,
        dismissed: [String: Date] = [:],
        maxAge: TimeInterval = maxAge,
        limit: Int = defaultLimit,
        exists: (String) -> Bool = directoryExists
    ) -> [BlockedPush] {
        var shown: [BlockedPush] = []
        for entry in entries where shown.count < limit {
            guard now.timeIntervalSince(entry.blockedAt) <= maxAge,
                  dismissed[entry.path].map({ entry.blockedAt > $0 }) ?? true,
                  exists(entry.path) else { continue }
            shown.append(entry)
        }
        return shown
    }

    /// Whether `path` is an existing directory.
    public static func directoryExists(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private struct Document: Decodable {
        let version: Int
        let entries: [RawEntry]
    }

    /// Every field optional and type-tolerant, so one bad entry does not hide the others.
    private struct RawEntry: Decodable {
        let root: String?
        let at: String?
        let reason: String?
        let summary: String?

        private enum CodingKeys: String, CodingKey { case root, at, reason, summary }

        init(from decoder: Decoder) throws {
            let container = try? decoder.container(keyedBy: CodingKeys.self)
            root = try? container?.decodeIfPresent(String.self, forKey: .root)
            at = try? container?.decodeIfPresent(String.self, forKey: .at)
            reason = try? container?.decodeIfPresent(String.self, forKey: .reason)
            summary = try? container?.decodeIfPresent(String.self, forKey: .summary)
        }
    }

    static func parseDate(_ text: String) -> Date? {
        // `Date.toISOString()` always has milliseconds; accept the plain form too.
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
