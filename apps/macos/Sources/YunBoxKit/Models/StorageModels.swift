import Foundation

/// The object stores direct mode can use, as `yunbox doctor --json` names them in `provider`.
public enum StorageProvider: String, Sendable, CaseIterable, Identifiable {
    case cos, s3
    public var id: String { rawValue }

    /// The short name the CLI puts in step titles (`COS 密钥`, `S3 密钥` …).
    public var stepLabel: String { rawValue.uppercased() }

    /// `yunbox login` for this provider; COS keeps the plain command older CLIs know.
    public var loginArguments: [String] { self == .cos ? [] : ["--provider", rawValue] }
}

/// Which S3-compatible service an endpoint belongs to, for labels and hints.
public enum S3Service: String, Sendable, CaseIterable, Identifiable {
    case r2, aws, minio, custom
    public var id: String { rawValue }

    public init(endpoint: String?) {
        let host = endpoint.flatMap { URL(string: $0)?.host() }?.lowercased() ?? ""
        if host.hasSuffix(".r2.cloudflarestorage.com") { self = .r2 }
        else if host == "amazonaws.com" || host.hasSuffix(".amazonaws.com") { self = .aws }
        else if host.contains("minio") { self = .minio }
        else { self = .custom }
    }

    public var name: String {
        switch self {
        case .r2: "Cloudflare R2"
        case .aws: "AWS S3"
        case .minio: "MinIO"
        case .custom: String(localized: "S3 兼容存储")
        }
    }

    /// The name in the header chip, kept short.
    public var shortName: String {
        switch self {
        case .r2: "R2"
        case .aws: "AWS S3"
        case .minio: "MinIO"
        case .custom: "S3"
        }
    }
}

/// `yunbox doctor --json`: how the repository uses YunBox and every check's outcome.
public struct DoctorReport: Decodable, Sendable, Equatable {
    /// `cos` is direct mode for every provider (the name older clients know); `provider` tells which.
    public enum Mode: String, Decodable, Sendable { case cos, server, none }

    public struct Location: Decodable, Sendable, Equatable {
        public let bucket: String
        public let region: String
        public let prefix: String
        /// The service origin without the bucket; S3-compatible storage only.
        public let endpoint: String?

        public init(bucket: String, region: String, prefix: String, endpoint: String? = nil) {
            self.bucket = bucket
            self.region = region
            self.prefix = prefix
            self.endpoint = endpoint
        }

        /// `bucket（region）/prefix/` for COS and `bucket（host）/prefix/` for S3, as the CLI prints them.
        public var label: String {
            let place = endpoint.flatMap { URL(string: $0) }.map { url in url.port.map { "\(url.host() ?? ""):\($0)" } ?? url.host() ?? "" } ?? region
            return "\(bucket)（\(place)）/\(prefix.isEmpty ? "" : "\(prefix)/")"
        }
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
    /// `cos` / `s3` in direct mode; absent from CLIs before S3 support, which only spoke COS.
    public let providerID: String?
    public let location: Location?
    public let steps: [Step]

    enum CodingKeys: String, CodingKey {
        case schemaVersion, status, mode, location, steps
        case providerID = "provider"
    }

    public var isHealthy: Bool { status == "ok" }
    public var failures: [Step] { steps.filter { $0.status == .fail } }

    /// The object store in direct mode; `nil` for a server or no setup, and for a provider this app does not know.
    public var provider: StorageProvider? {
        guard mode == .cos else { return nil }
        return StorageProvider(rawValue: providerID ?? StorageProvider.cos.rawValue)
    }

    /// The S3-compatible service, from the endpoint; `nil` unless the provider is S3.
    public var s3Service: S3Service? { provider == .s3 ? S3Service(endpoint: location?.endpoint) : nil }

    /// What the repository stores objects in, for labels: `COS`, `R2`, `AWS S3`, `MinIO`, `S3` ….
    public var storageName: String {
        if let s3Service { return s3Service.shortName }
        if mode == .cos, provider == nil, let providerID { return providerID.uppercased() }
        return "COS"
    }

    /// The full name for sentences: `腾讯云 COS`, `Cloudflare R2`, `S3 兼容存储` ….
    public var storageFullName: String {
        if let s3Service { return s3Service.name }
        return provider == .cos || mode != .cos ? String(localized: "腾讯云 COS") : storageName
    }

    /// True when the only problem is that this machine has no keys for the repository's store yet.
    public var needsLogin: Bool {
        guard let provider = provider ?? (mode == .none ? .cos : nil) else { return false }
        return failures.contains { $0.title == "\(provider.stepLabel) 密钥" }
    }

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

/// What the window asks for to connect a repository to S3-compatible storage with `git yunbox init`.
/// S3 services cannot list or create buckets through YunBox; the bucket must already exist.
public struct S3Setup: Sendable, Equatable {
    public var service: S3Service = .r2
    /// Cloudflare account ID (32 hex digits), R2 only.
    public var accountID = ""
    /// Service origin without the bucket; MinIO and custom services.
    public var endpoint = ""
    /// AWS region, or a custom service's region; empty uses the preset's default.
    public var region = ""
    public var bucket = ""
    public var prefix = ""

    public init(service: S3Service = .r2, accountID: String = "", endpoint: String = "", region: String = "", bucket: String = "", prefix: String = "") {
        self.service = service
        self.accountID = accountID
        self.endpoint = endpoint
        self.region = region
        self.bucket = bucket
        self.prefix = prefix
    }

    /// Why the form cannot run yet, or `nil` when it can.
    public var problem: String? {
        if service == .r2, trimmed(accountID).range(of: #"^[0-9a-fA-F]{32}$"#, options: .regularExpression) == nil {
            return String(localized: "R2 账户 ID 是 32 位十六进制字符，在 Cloudflare 控制台的 R2 概览页可以复制。")
        }
        if service == .minio || service == .custom {
            guard let url = URL(string: trimmed(endpoint)), let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased(), !host.isEmpty else {
                return String(localized: "填写服务地址（不含 bucket），例如 https://minio.example.com。")
            }
            let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
            if scheme != "https" && !(scheme == "http" && local) {
                return String(localized: "服务地址必须是 https，只有本机地址可以用 http。")
            }
        }
        if trimmed(bucket).isEmpty { return String(localized: "填写已在服务控制台建好的 bucket 名称。") }
        return nil
    }

    /// `git yunbox init` arguments after `init`; `--yes` because the window has already asked everything.
    public var initArguments: [String] {
        var arguments = ["--provider", "s3"]
        switch service {
        case .r2: arguments += ["--preset", "r2", "--account-id", trimmed(accountID).lowercased()]
        case .aws: arguments += ["--preset", "aws"]
        case .minio: arguments += ["--preset", "minio", "--endpoint", trimmed(endpoint)]
        case .custom: arguments += ["--endpoint", trimmed(endpoint)]
        }
        if service != .r2, !trimmed(region).isEmpty { arguments += ["--region", trimmed(region)] }
        return arguments + ["--bucket", trimmed(bucket), "--prefix", trimmed(prefix), "--yes"]
    }

    private func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
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

    /// How a line of CLI output starts: `printStep`'s `✓` / `!` / `✗` / `-`, or the `错误：` of a failed command.
    public enum Mark: Sendable, Equatable {
        case pass, warn, fail, skip, error
    }

    /// One output line and the mark it starts with; `mark` and `body` together are the line's full text.
    public struct Line: Sendable, Equatable {
        public let mark: Mark?
        /// The marker as printed (`✓`, `错误：` …), empty when `mark` is `nil`.
        public let marker: String
        public let body: String
    }

    /// The output split into lines, with the step marks the CLI prints at the start of a line recognised.
    /// Indented lines (fix commands, wrapped details) never carry a mark.
    public var lines: [Line] {
        text.trimmingCharacters(in: .newlines).split(separator: "\n", omittingEmptySubsequences: false).map { line in
            let line = String(line)
            for (marker, mark) in [("✓ ", Mark.pass), ("! ", .warn), ("✗ ", .fail), ("- ", .skip), ("错误：", .error)] where line.hasPrefix(marker) {
                return Line(mark: mark, marker: marker, body: String(line.dropFirst(marker.count)))
            }
            return Line(mark: nil, marker: "", body: line)
        }
    }
}
