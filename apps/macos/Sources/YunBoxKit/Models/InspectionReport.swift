import Foundation

/// The CLI's versioned JSON contract. LFS uploadBytes remains optional, never coerced to zero.
public struct InspectionReport: Decodable, Sendable {
    public let schemaVersion: Int
    public let status: String
    public let limits: Limits
    public let warnings: [String]
    /// Per-path changes; `nil` in reports from a CLI older than this field.
    public let changes: [Change]?
    public let git: GitSummary
    public let lfs: LFSSummary

    public struct Limits: Decodable, Sendable {
        public let gitBytes: Int64
        public let lfsBytes: Int64
        public let fileBytes: Int64
    }

    public struct GitSummary: Decodable, Sendable {
        public let packBytes: Int64
        public let packComplete: Bool
        public let packCapBytes: Int64
        public let exceedsLimit: Bool
        public let blobBytes: Int64
        public let blobCount: Int
        public let pointerBytes: Int64
        public let files: [ContentObject]
    }

    public struct LFSSummary: Decodable, Sendable {
        public let candidateBytes: Int64
        public let candidateCount: Int
        public let remoteChecked: Bool
        public let uploadBytes: Int64?
        public let exceedsLimit: Bool
        public let files: [ContentObject]
    }

    /// One path's net change across the pushed commits.
    public struct Change: Decodable, Sendable {
        public let path: String
        /// `added`, `modified`, `deleted` or `transient` (added and deleted again within the push).
        public let status: String
        public let storage: String
        public let beforeBytes: Int64?
        public let afterBytes: Int64?
        /// LFS payload SHA-256 for LFS files, Git blob ID otherwise; `nil` from older CLIs too.
        public let beforeOid: String?
        public let afterOid: String?
        public let versions: Int
        public let pushBytes: Int64
        public let exceedsFileLimit: Bool

        public var statusLabel: String {
            switch status {
            case "added": String(localized: "新增")
            case "modified": String(localized: "修改")
            case "deleted": String(localized: "删除")
            case "transient": String(localized: "临时")
            default: status
            }
        }
    }

    public struct ContentObject: Decodable, Sendable {
        public let oid: String
        public let bytes: Int64
        public let paths: [String]
        public let exceedsFileLimit: Bool
    }

    /// The change a content object belongs to: the path it is the pushed version of, else any of its paths.
    public func change(for row: FileRow) -> Change? {
        change(for: row, in: changesByPath())
    }

    /// `change(for:)` of every file row, keyed by row ID.
    public func changeIndex() -> [String: Change] {
        let byPath = changesByPath()
        var index: [String: Change] = [:]
        for row in files { index[row.id] = change(for: row, in: byPath) }
        return index
    }

    private func changesByPath() -> [String: Change] {
        Dictionary((changes ?? []).map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private func change(for row: FileRow, in byPath: [String: Change]) -> Change? {
        let candidates = row.object.paths.compactMap { byPath[$0] }
        return candidates.first { $0.afterOid == row.object.oid } ?? candidates.first
    }

    public var files: [FileRow] {
        (git.files.map { FileRow(kind: .git, object: $0) }
            + lfs.files.map { FileRow(kind: .lfs, object: $0) })
            .sorted { $0.object.bytes == $1.object.bytes ? $0.id < $1.id : $0.object.bytes > $1.object.bytes }
    }
}

public enum FileKind: String, CaseIterable, Sendable {
    case git = "Git"
    case lfs = "LFS"
}

public struct FileRow: Identifiable, Sendable {
    public let kind: FileKind
    public let object: InspectionReport.ContentObject
    public var id: String { "\(kind.rawValue):\(object.oid)" }
    public var path: String { object.paths.first ?? String(localized: "路径未知 · \(String(object.oid.prefix(12)))") }

    public func matches(_ query: String) -> Bool {
        query.isEmpty || object.oid.localizedCaseInsensitiveContains(query)
            || object.paths.contains { $0.localizedCaseInsensitiveContains(query) }
    }
}

public struct InspectionResult: Sendable {
    public let report: InspectionReport
    public let json: Data

    /// Exit 1 means a valid over-budget report, not a process failure.
    public static func decode(_ data: Data, exitCode: Int32) throws -> InspectionResult {
        struct Envelope: Decodable {
            let schemaVersion: Int
            let status: String
            let error: Failure?
            struct Failure: Decodable { let message: String }
        }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data), envelope.schemaVersion == 1 else {
            throw InspectionFailure.invalidReport
        }
        if envelope.status == "error" {
            throw InspectionFailure.cli(envelope.error?.message ?? String(localized: "检查失败，请确认所选目录是已有提交的 Git 仓库。"))
        }
        guard (exitCode == 0 && envelope.status == "ok") || (exitCode == 1 && envelope.status == "exceeded"),
              let report = try? JSONDecoder().decode(InspectionReport.self, from: data) else {
            throw InspectionFailure.invalidReport
        }
        return InspectionResult(report: report, json: data)
    }
}

public enum InspectionFailure: LocalizedError, Sendable {
    case invalidReport, missingNode, missingCLI, timedOut, outputTooLarge
    case cli(String)

    public var errorDescription: String? {
        switch self {
        case .invalidReport: String(localized: "无法读取检查报告。请重新构建 YunBox 客户端，确认 CLI 接口版本兼容。")
        case .missingNode: String(localized: "没有找到 Node.js。请在设置中选择 Node.js 可执行文件，然后重试。")
        case .missingCLI: String(localized: "应用内缺少检查组件，请使用构建脚本重新安装 YunBox。")
        case .timedOut: String(localized: "检查超过 120 秒，已停止。可先 fetch 补齐历史，或在终端用 --base 缩小范围。")
        case .outputTooLarge: String(localized: "报告超过 64 MiB，请在终端用 --base 缩小检查范围。")
        case .cli(let message): message
        }
    }
}

public func byteLabel(_ bytes: Int64) -> String {
    let units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"]
    var value = Double(bytes)
    var unit = 0
    while value >= 1024 && unit < units.count - 1 {
        value /= 1024
        unit += 1
    }
    return "\(value.formatted(.number.precision(.fractionLength(0...2)))) \(units[unit])"
}
