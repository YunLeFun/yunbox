import CryptoKit
import Foundation

/// The last inspection of one repository, as read back from disk.
public struct CachedInspection: Sendable {
    public let result: InspectionResult
    public let checkedAt: Date
}

/// Keeps the most recent inspection report of each repository on disk.
///
/// Each repository gets two files named after the SHA-256 of its path: the CLI's raw JSON report,
/// unchanged, and a small metadata file. Reports are decoded with the same validation as a live
/// run, so a cache written by an incompatible CLI version is ignored instead of shown.
public struct InspectionCache: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// `~/Library/Application Support/YunBox/InspectionCache`.
    public static func standard() -> InspectionCache? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return InspectionCache(directory: support.appending(path: "YunBox/InspectionCache", directoryHint: .isDirectory))
    }

    private struct Metadata: Codable {
        let version: Int
        let path: String
        let checkedAt: Date
        let exitCode: Int32
    }

    public func load(path: String) -> CachedInspection? {
        let urls = files(for: path)
        guard let metadataData = try? Data(contentsOf: urls.metadata),
              let metadata = try? decoder.decode(Metadata.self, from: metadataData),
              metadata.version == 1, metadata.path == path,
              let report = try? Data(contentsOf: urls.report),
              let result = try? InspectionResult.decode(report, exitCode: metadata.exitCode) else {
            return nil
        }
        return CachedInspection(result: result, checkedAt: metadata.checkedAt)
    }

    public func store(_ result: InspectionResult, path: String, checkedAt: Date) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let urls = files(for: path)
        let exitCode: Int32 = result.report.status == "exceeded" ? 1 : 0
        // Report first, metadata last: a reader never pairs new metadata with an old report.
        try result.json.write(to: urls.report, options: .atomic)
        try encoder.encode(Metadata(version: 1, path: path, checkedAt: checkedAt, exitCode: exitCode))
            .write(to: urls.metadata, options: .atomic)
    }

    public func remove(path: String) {
        let urls = files(for: path)
        try? FileManager.default.removeItem(at: urls.metadata)
        try? FileManager.default.removeItem(at: urls.report)
    }

    /// Delete cached reports for every repository not in `paths`.
    public func prune(keeping paths: [String]) {
        let keep = Set(paths.map(key))
        guard let entries = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for entry in entries where !keep.contains(String(entry.lastPathComponent.prefix(64))) {
            try? FileManager.default.removeItem(at: entry)
        }
    }

    private func files(for path: String) -> (metadata: URL, report: URL) {
        let name = key(path)
        return (directory.appending(path: "\(name).meta.json"), directory.appending(path: "\(name).report.json"))
    }

    private func key(_ path: String) -> String {
        SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
