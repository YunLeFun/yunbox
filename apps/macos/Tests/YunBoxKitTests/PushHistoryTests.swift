import Foundation
import Testing
@testable import YunBoxKit

private let historyEntries = #"""
[
 {"id":"continue","root":"/work/game","at":"2026-10-25T02:00:00.001Z","reason":"exceeded","outcome":"continued","summary":"超过预算","note":"已确认素材用途"},
 {"id":"cancel","root":"/work/game","at":"2026-10-25T01:00:00Z","reason":"exceeded","outcome":"cancelled","summary":"超过预算","note":"先压缩图片"},
 {"id":"freeze","root":"/work/game","at":"2026-10-25T00:00:00Z","reason":"freeze","outcome":"blocked","summary":"禁推时段"}
]
"""#

@Test func decodesUnderBudgetConfirmationsAndDistinguishesUnavailableUI() throws {
    let json = #"{"version":1,"entries":[{"id":"confirm","root":"/work/game","at":"2026-10-25T02:00:00.001Z","reason":"confirmation","outcome":"blocked","summary":"每次推送确认（未超限）"}]}"#
    let entries = PushHistoryReport.decodeEntries(Data(json.utf8))
    #expect(entries.count == 1)
    #expect(entries[0].reason == .confirmation)
    let directory = FileManager.default.temporaryDirectory.appending(path: "yunbox-confirmation-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data(json.utf8).write(to: directory.appending(path: "push-history.json"))
    let blocked = BlockedPushes.load(from: directory.appending(path: "blocked-pushes.json"))
    #expect(blocked.first?.reason == .confirmation)
}

@Test func decodesMultipleDecisionsForOneProjectIncludingContinuation() throws {
    let data = Data((#"{"version":1,"file":"/local/push-history.json","retention":{"days":90,"perRepository":200,"total":5000},"entries": "# + historyEntries + "}").utf8)
    let report = try PushHistoryReport.decode(data, exitCode: 0)
    #expect(report.entries.count == 3)
    #expect(report.entries[0].outcome == .continued)
    #expect(report.entries[0].note == "已确认素材用途")
    #expect(report.entries[1].outcome == .cancelled)
    #expect(report.entries[2].reason == .freeze)
    #expect(report.retention.days == 90)
    #expect(report.retention.perRepository == 200)
    #expect(report.file == "/local/push-history.json")
    #expect(throws: (any Error).self) { try PushHistoryReport.decode(data, exitCode: 1) }
}

@Test func recentBlockedShortcutUsesHistoryWithoutTreatingContinuationsAsBlocks() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "yunbox-history-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let old = directory.appending(path: "blocked-pushes.json")
    try Data(#"{"version":1,"entries":[{"root":"/work/legacy","at":"2026-10-24T01:00:00Z","reason":"freeze","summary":"old"}]}"#.utf8).write(to: old)
    let file = directory.appending(path: "push-history.json")
    try Data((#"{"version":1,"entries": "# + historyEntries + "}").utf8).write(to: file)
    let latest = BlockedPushes.load(from: old)
    #expect(latest.count == 1)
    #expect(latest[0].path == "/work/game")
    #expect(latest[0].reason == .cancelled)
    #expect(latest[0].summary.contains("先压缩图片"))
    try Data(#"{"version":1,"entries":[]}"#.utf8).write(to: file)
    #expect(BlockedPushes.load(from: old).isEmpty)
}
