import Foundation

/// Effective push protection and the local tools required by the setup assistant.
public struct HookStatus: Decodable, Sendable {
    public struct Tool: Decodable, Sendable {
        public let found: Bool
        public let version: String?
        public let reason: String?
    }

    public let version: Int
    public let repository: Bool
    public let hook: String
    public let scope: String?
    public let confirm: Bool
    public let globalInstalled: Bool
    public let customPath: Bool
    public let node: String
    public let nodeReady: Bool
    public let git: Tool
    public let lfs: Tool
    public let ready: Bool

    public var isProtected: Bool { repository && hook == "inspect" }

    public static func decode(_ data: Data, exitCode: Int32) throws -> HookStatus {
        guard exitCode == 0 else { throw InspectionFailure.invalidReport }
        let report = try JSONDecoder().decode(Self.self, from: data)
        guard report.version == 1 else { throw InspectionFailure.invalidReport }
        return report
    }
}
