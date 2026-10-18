import Foundation

/// `yunbox doctor --json`: how the repository uses YunBox and every check's outcome.
public struct DoctorReport: Decodable, Sendable, Equatable {
    public enum Mode: String, Decodable, Sendable { case cos, server, none }

    public struct Location: Decodable, Sendable, Equatable {
        public let bucket: String
        public let region: String
        public let prefix: String

        /// `bucket（region）/prefix/` as the CLI prints it.
        public var label: String { "\(bucket)（\(region)）/\(prefix.isEmpty ? "" : "\(prefix)/")" }
    }

    public struct Step: Decodable, Sendable, Equatable, Identifiable {
        public enum Status: String, Decodable, Sendable { case pass, warn, fail, skip }
        public let status: Status
        public let title: String
        public let detail: String?
        public let fixes: [String]?
        public var id: String { "\(title)|\(detail ?? "")" }
    }

    public let schemaVersion: Int
    public let status: String
    public let mode: Mode
    public let location: Location?
    public let steps: [Step]

    public var isHealthy: Bool { status == "ok" }
    public var failures: [Step] { steps.filter { $0.status == .fail } }
    /// True when the only problem is that this machine has no Tencent Cloud keys yet.
    public var needsLogin: Bool { failures.contains { $0.title == "COS 密钥" } }

    /// Decode the single JSON object; exit codes 0 (all pass) and 1 (some fail) are both valid reports.
    public static func decode(_ data: Data, exitCode: Int32) throws -> DoctorReport {
        guard exitCode == 0 || exitCode == 1,
              let report = try? JSONDecoder().decode(DoctorReport.self, from: data),
              report.schemaVersion == 1 else {
            throw InspectionFailure.invalidReport
        }
        return report
    }
}

/// A bucket from `yunbox buckets --json`.
public struct CosBucket: Decodable, Sendable, Hashable, Identifiable {
    public let name: String
    public let region: String
    public var id: String { name }
}

/// `yunbox buckets --json`.
public struct BucketListing: Decodable, Sendable {
    public struct Failure: Decodable, Sendable {
        public let code: String
        public let message: String
    }

    public let schemaVersion: Int
    public let status: String
    public let buckets: [CosBucket]?
    public let error: Failure?

    /// The buckets, or a ``BucketListingError`` carrying the CLI's code and message.
    public static func decode(_ data: Data) throws -> [CosBucket] {
        guard let listing = try? JSONDecoder().decode(BucketListing.self, from: data), listing.schemaVersion == 1 else {
            throw InspectionFailure.invalidReport
        }
        if let error = listing.error { throw BucketListingError(code: error.code, message: error.message) }
        return listing.buckets ?? []
    }
}

/// Why `yunbox buckets` could not list buckets; `code` is `NO_CREDENTIALS`, `ACCESS_DENIED`, ….
public struct BucketListingError: LocalizedError, Sendable, Equatable {
    public let code: String
    public let message: String
    public var errorDescription: String? { message }
    public var needsLogin: Bool { code == "NO_CREDENTIALS" || code == "INVALID_CREDENTIALS" }

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// Text a setup command printed (stdout and stderr together) and how it exited.
public struct CommandOutput: Sendable {
    public let exitCode: Int32
    public let text: String
    public var succeeded: Bool { exitCode == 0 }

    public init(exitCode: Int32, text: String) {
        self.exitCode = exitCode
        self.text = text
    }
}
