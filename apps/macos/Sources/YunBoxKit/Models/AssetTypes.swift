import Foundation

/// `git yunbox types --json`: which asset types go through LFS, their files, and assets committed as ordinary files.
public struct AssetTypesReport: Decodable, Sendable, Equatable {
    public struct Extension: Decodable, Sendable, Equatable, Identifiable {
        public let `extension`: String
        public let pattern: String
        /// A file with this extension at the repository root goes through LFS.
        public let lfs: Bool
        /// The rule is in the block YunBox generated, so `types remove` can delete it; otherwise it comes from another rule.
        public let managed: Bool
        /// Files in the index with this extension, in any case.
        public let files: Int
        /// How many of them are staged as LFS pointers.
        public let lfsFiles: Int
        public var id: String { pattern }
    }

    public struct Category: Decodable, Sendable, Equatable, Identifiable {
        public enum State: String, Decodable, Sendable { case lfs, partial, none }
        public let id: String
        public let label: String
        public let state: State
        public let extensions: [Extension]

        /// The label in the interface's language; types a newer CLI adds keep the CLI's label.
        public var title: String { AssetTypesReport.title(of: id) ?? label }
        public var files: Int { extensions.reduce(0) { $0 + $1.files } }
        public var lfsFiles: Int { extensions.reduce(0) { $0 + $1.lfsFiles } }
        public var trackedCount: Int { extensions.filter(\.lfs).count }
        /// `types remove` has something to delete.
        public var hasManagedRules: Bool { extensions.contains(where: \.managed) }
        /// Extensions that go through LFS because of a hand-written or `git lfs track` rule.
        public var otherRuleCount: Int { extensions.filter { $0.lfs && !$0.managed }.count }
    }

    public struct Preset: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String
        public let categories: [String]

        public var title: String {
            switch id {
            case "game": String(localized: "游戏项目（不含压缩包）")
            case "design": String(localized: "设计稿")
            case "media": String(localized: "图片和音视频")
            case "all": String(localized: "全部类型")
            default: label
            }
        }
    }

    public struct PlainFile: Decodable, Sendable, Equatable, Identifiable {
        public enum Reason: String, Decodable, Sendable, CaseIterable {
            /// The extension differs in case and the lower-case rule does not catch it (`core.ignorecase=false`).
            case `case`
            /// An LFS rule catches it, but it was committed before the rule; it shows as modified.
            case notRenormalized = "not-renormalized"
            /// No LFS rule catches it.
            case noRule = "no-rule"
        }

        public let path: String
        public let category: String
        /// As written in the path, e.g. `PNG`.
        public let `extension`: String
        public let reason: Reason
        public var id: String { path }
    }

    /// Plain files with one reason, by category in the report's order.
    public struct PlainFileGroup: Sendable, Equatable, Identifiable {
        public struct Part: Sendable, Equatable, Identifiable {
            public let category: Category
            public let files: [PlainFile]
            public var id: String { category.id }
        }

        public let reason: PlainFile.Reason
        public let parts: [Part]
        public var id: String { reason.rawValue }
        public var count: Int { parts.reduce(0) { $0 + $1.files.count } }
    }

    public let schemaVersion: Int
    public let status: String
    public let categories: [Category]
    public let presets: [Preset]
    public let plainFiles: [PlainFile]

    /// Every category of `preset` already goes through LFS.
    public func isApplied(_ preset: Preset) -> Bool {
        preset.categories.allSatisfy { id in categories.first { $0.id == id }?.state == .lfs }
    }

    /// Plain files grouped by reason (in ``PlainFile/Reason/allCases`` order), then by category.
    public var plainFileGroups: [PlainFileGroup] {
        PlainFile.Reason.allCases.compactMap { reason in
            let files = plainFiles.filter { $0.reason == reason }
            guard !files.isEmpty else { return nil }
            let parts = categories.compactMap { category -> PlainFileGroup.Part? in
                let own = files.filter { $0.category == category.id }
                return own.isEmpty ? nil : PlainFileGroup.Part(category: category, files: own)
            }
            return PlainFileGroup(reason: reason, parts: parts)
        }
    }

    /// Categories' labels in the interface's language, by the CLI's id.
    static func title(of id: String) -> String? {
        switch id {
        case "texture": String(localized: "贴图和图片")
        case "source": String(localized: "设计源文件")
        case "model": String(localized: "模型和动画")
        case "audio": String(localized: "音频")
        case "video": String(localized: "视频")
        case "font": String(localized: "字体")
        case "archive": String(localized: "压缩包")
        default: nil
        }
    }

    private struct Envelope: Decodable {
        struct Failure: Decodable { let message: String }
        let schemaVersion: Int
        let status: String
        let error: Failure?
    }

    /// Decode the single JSON object; a `status: "error"` object becomes ``InspectionFailure/cli(_:)`` with its message.
    public static func decode(_ data: Data, exitCode: Int32) throws -> AssetTypesReport {
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data), envelope.schemaVersion == 1 else {
            throw InspectionFailure.invalidReport
        }
        if envelope.status == "error" {
            throw InspectionFailure.cli(envelope.error?.message ?? String(localized: "无法读取素材类型。"))
        }
        guard exitCode == 0, envelope.status == "ok",
              let report = try? JSONDecoder().decode(AssetTypesReport.self, from: data) else {
            throw InspectionFailure.invalidReport
        }
        return report
    }
}
