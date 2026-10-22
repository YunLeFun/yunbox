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

@Test func keepsPinnedRepositoriesFirstAndOutsideTheLimit() {
    var recents = RecentRepositories(paths: ["/a", "/b", "/c"], pinned: ["/b", "/p"], limit: 2)
    #expect(recents.pinned == ["/b", "/p"])
    #expect(recents.paths == ["/a", "/c"])
    #expect(recents.all == ["/b", "/p", "/a", "/c"])
    #expect(recents.open("/p").isEmpty)
    recents.pin("/a")
    #expect(recents.pinned == ["/b", "/p", "/a"])
    #expect(recents.paths == ["/c"])
    #expect(recents.open("/d").isEmpty)
    #expect(recents.open("/e") == ["/c"])
    #expect(recents.unpin("/b") == ["/d"])
    #expect(recents.all == ["/p", "/a", "/b", "/e"])
    recents.movePinned(fromOffsets: [1], toOffset: 0)
    #expect(recents.pinned == ["/a", "/p"])
    recents.remove("/a")
    #expect(recents.pinned == ["/p"])
}

@Test func mergesRepositoriesUsedElsewhereAboveTheRecentList() {
    var recents = RecentRepositories(paths: ["/a", "/b"], pinned: ["/p"], limit: 3)
    #expect(recents.merge(["/n", "/p", "/a", "/m", "/n"]) == ["/b"])
    #expect(recents.paths == ["/n", "/m", "/a"])
    #expect(recents.merge([]).isEmpty)
}

@Test func readsTheRecordOfRepositoriesTheCLIUsed() throws {
    let json = Data(#"""
    {"version":1,"entries":[
      {"root":"/work/old","at":"2026-10-20T01:00:00.000Z"},
      {"root":"/work/new/","at":"2026-10-21T01:00:00Z"},
      {"root":"relative","at":"2026-10-21T02:00:00.000Z"},
      {"root":"/work/gone","at":"2026-10-21T00:30:00.000Z"},
      {"root":42}
    ]}
    """#.utf8)
    #expect(UsedRepositories.decode(json).map(\.path) == ["/work/new", "/work/gone", "/work/old"])
    #expect(UsedRepositories.decode(Data(#"{"version":2,"entries":[]}"#.utf8)).isEmpty)
    let file = FileManager.default.temporaryDirectory.appending(path: "yunbox-used-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: file) }
    try json.write(to: file)
    let since = ISO8601DateFormatter().date(from: "2026-10-20T12:00:00Z")
    let loaded = UsedRepositories.load(from: file, since: since, exists: { $0 != "/work/gone" })
    #expect(loaded.paths == ["/work/new"])
    #expect(loaded.latest == ISO8601DateFormatter().date(from: "2026-10-21T01:00:00Z"))
    #expect(UsedRepositories.load(from: file, since: nil, exists: { _ in true }).paths.count == 3)
    #expect(UsedRepositories.fileURL(environment: ["YUNBOX_CONFIG_DIR": "/cfg"]).path == "/cfg/repositories.json")
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
