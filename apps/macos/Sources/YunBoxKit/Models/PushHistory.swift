import Foundation

/// A locally recorded protection decision; continuing does not establish upload success.
public struct PushHistoryEntry: Decodable, Sendable, Identifiable, Equatable {
    public enum Reason: String, Decodable, Sendable { case freeze, exceeded }
    public enum Outcome: String, Decodable, Sendable { case blocked, cancelled, continued }

    public let id: String
    public let root: String
    public let at: Date
    public let reason: Reason
    public let outcome: Outcome
    public let summary: String
    public let note: String?
}

/// `yunbox history --all --json`, including storage location and automatic retention limits.
public struct PushHistoryReport: Decodable, Sendable {
    public struct Retention: Decodable, Sendable {
        public let days: Int
        public let perRepository: Int
        public let total: Int
    }

    public let version: Int
    public let entries: [PushHistoryEntry]
    public let retention: Retention
    public let file: String

    public static func decode(_ data: Data, exitCode: Int32) throws -> PushHistoryReport {
        guard exitCode == 0 else { throw HistoryError.unavailable }
        let result = try decoder().decode(PushHistoryReport.self, from: data)
        guard result.version == 1 else { throw HistoryError.unsupported }
        return result
    }

    /// The sidebar can read the same canonical file without starting a command.
    public static func decodeEntries(_ data: Data) -> [PushHistoryEntry] {
        struct Entry: Decodable {
            let value: PushHistoryEntry?
            init(from decoder: Decoder) throws { value = try? PushHistoryEntry(from: decoder) }
        }
        struct Document: Decodable { let version: Int; let entries: [Entry] }
        guard let result = try? decoder().decode(Document.self, from: data), result.version == 1 else { return [] }
        return result.entries.compactMap(\.value).sorted { $0.at > $1.at }
    }

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = BlockedPushes.parseDate(text) else { throw HistoryError.unavailable }
            return date
        }
        return decoder
    }
}

private enum HistoryError: LocalizedError {
    case unavailable, unsupported
    var errorDescription: String? {
        switch self {
        case .unavailable: String(localized: "无法读取本机推送历史，请刷新后重试。")
        case .unsupported: String(localized: "推送历史格式不受支持，请更新云匣。")
        }
    }
}
