import Foundation
import Testing
@testable import YunBoxKit

private let okJSON = #"{"schemaVersion":1,"status":"ok","limits":{"gitBytes":921600,"lfsBytes":104857600,"fileBytes":10485760},"warnings":[],"git":{"packBytes":10,"packComplete":true,"packCapBytes":10485760,"exceedsLimit":false,"blobBytes":10,"blobCount":1,"pointerBytes":0,"files":[{"oid":"a","bytes":10,"paths":["a.txt"],"exceedsFileLimit":false}]},"lfs":{"candidateBytes":0,"candidateCount":0,"remoteChecked":false,"uploadBytes":null,"exceedsLimit":false,"files":[]}}"#
private let exceededJSON = okJSON
    .replacingOccurrences(of: #""status":"ok""#, with: #""status":"exceeded""#)
    .replacingOccurrences(of: #""exceedsLimit":false,"blobBytes""#, with: #""exceedsLimit":true,"blobBytes""#)

@Test func keepsRecentOrderStableWhenReopening() {
    var recents = RecentRepositories(paths: ["/a", "/b", "/c"])
    #expect(recents.open("/b").isEmpty)
    #expect(recents.paths == ["/a", "/b", "/c"])
    recents.open("/d")
    #expect(recents.paths == ["/d", "/a", "/b", "/c"])
    recents.remove("/a")
    #expect(recents.paths == ["/d", "/b", "/c"])
}

@Test func dropsOldestRecentBeyondLimitAndDeduplicatesStoredPaths() {
    var recents = RecentRepositories(paths: ["/a", "/a", "/b"], limit: 2)
    #expect(recents.paths == ["/a", "/b"])
    #expect(recents.open("/c") == ["/b"])
    #expect(recents.paths == ["/c", "/a"])
}

@Test func roundTripsReportsPerRepositoryAndPrunes() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "yunbox-cache-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = InspectionCache(directory: directory)
    #expect(cache.load(path: "/repo/one") == nil)

    let ok = try InspectionResult.decode(Data(okJSON.utf8), exitCode: 0)
    let exceeded = try InspectionResult.decode(Data(exceededJSON.utf8), exitCode: 1)
    let checkedAt = Date(timeIntervalSince1970: 1_792_000_000)
    try cache.store(ok, path: "/repo/one", checkedAt: checkedAt)
    try cache.store(exceeded, path: "/repo/二", checkedAt: checkedAt)

    let one = try #require(cache.load(path: "/repo/one"))
    #expect(one.result.json == ok.json)
    #expect(one.result.report.status == "ok")
    #expect(one.checkedAt == checkedAt)
    #expect(cache.load(path: "/repo/二")?.result.report.status == "exceeded")

    cache.prune(keeping: ["/repo/二"])
    #expect(cache.load(path: "/repo/one") == nil)
    #expect(cache.load(path: "/repo/二") != nil)
    cache.remove(path: "/repo/二")
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
}

@Test func ignoresCachedReportsFromAnIncompatibleCLI() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "yunbox-cache-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = InspectionCache(directory: directory)
    try cache.store(try InspectionResult.decode(Data(okJSON.utf8), exitCode: 0), path: "/repo", checkedAt: Date())
    let report = try #require(try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        .first { $0.lastPathComponent.hasSuffix(".report.json") })
    try Data(okJSON.replacingOccurrences(of: #""schemaVersion":1"#, with: #""schemaVersion":2"#).utf8).write(to: report)
    #expect(cache.load(path: "/repo") == nil)
}
