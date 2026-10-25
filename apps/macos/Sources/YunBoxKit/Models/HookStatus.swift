import Foundation

/// Effective push protection and the local tools required by the setup assistant.
public struct HookStatus: Decodable, Sendable {
    public struct Tool: Decodable, Sendable {
        public let found: Bool
        public let version: String?
        public let reason: String?
    }

    public struct Compatibility: Decodable, Sendable {
        public let registered: Bool
        public let state: String
        public let originalPath: String?
        public let missing: String?
    }

    public let compatibility: Compatibility?
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

    public var needsCompatibility: Bool {
        repository && !isProtected && compatibility?.registered != true && customPath
    }
    public var isOverridden: Bool { compatibility?.state == "overridden" }

    public var isProtected: Bool { repository && hook == "inspect" }

    public static func decode(_ data: Data, exitCode: Int32) throws -> HookStatus {
        guard exitCode == 0 else { throw InspectionFailure.invalidReport }
        let report = try JSONDecoder().decode(Self.self, from: data)
        guard report.version == 1 else { throw InspectionFailure.invalidReport }
        return report
    }
}

/// Coverage of explicitly known repositories; unreadable entries never count as protected.
public struct HookCoverage: Sendable {
    public let protected: Int
    public let pending: Int
    public let overridden: Int
    public let unprotected: Int
    public let unavailable: Int

    public init(statuses: [HookStatus], unavailable: Int) {
        self.protected = statuses.filter { $0.isProtected }.count
        self.pending = statuses.filter { $0.needsCompatibility }.count
        self.overridden = statuses.filter { !$0.isProtected && $0.isOverridden }.count
        self.unprotected = statuses.filter { $0.repository && !$0.isProtected && !$0.needsCompatibility && !$0.isOverridden }.count
        self.unavailable = unavailable + statuses.filter { !$0.repository }.count
    }
}
