import Foundation
import Testing
@testable import YunBoxKit

private let record = #"""
{
  "version": 1,
  "entries": [
    { "root": "/work/game", "at": "2026-10-20T13:50:26.484Z", "reason": "cancelled", "summary": "1 个文件版本超过单文件限额 4.00 KiB" },
    { "root": "/work/site/../art", "at": "2026-10-19T08:00:00Z", "reason": "freeze", "summary": "禁推时段 24/7（团队 .yunbox/config）" },
    { "root": "/work/old", "at": "2026-09-01T08:00:00.000Z", "reason": "exceeded", "summary": "" },
    { "root": "relative/path", "at": "2026-10-20T00:00:00.000Z", "reason": "freeze", "summary": "" },
    { "root": "/work/future", "at": "2026-10-20T00:00:00.000Z", "reason": "unknown", "summary": "" },
    { "root": 42, "at": "2026-10-20T00:00:00.000Z", "reason": "freeze", "summary": "" },
    { "root": "/work/game", "at": "2026-10-18T00:00:00.000Z", "reason": "freeze", "summary": "older duplicate" }
  ]
}
"""#

private func date(_ text: String) -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)!
}

@Test func decodesTheCliRecordAndSkipsBadEntries() {
    let entries = BlockedPushes.decode(Data(record.utf8))
    #expect(entries.map(\.path) == ["/work/game", "/work/art", "/work/old"])
    #expect(entries[0] == BlockedPush(path: "/work/game", blockedAt: date("2026-10-20T13:50:26.484Z"), reason: .cancelled, summary: "1 个文件版本超过单文件限额 4.00 KiB"))
    #expect(entries[1].reason == .freeze)
    #expect(entries[1].blockedAt == date("2026-10-19T08:00:00Z"))
    #expect(BlockedPushes.decode(Data(#"{"version":2,"entries":[]}"#.utf8)).isEmpty)
    #expect(BlockedPushes.decode(Data("not json".utf8)).isEmpty)
}

@Test func showsRecentExistingUndismissedEntries() {
    let entries = BlockedPushes.decode(Data(record.utf8))
    let now = date("2026-10-20T14:00:00Z")
    let everything: (String) -> Bool = { _ in true }
    #expect(BlockedPushes.recent(entries, now: now, exists: everything).map(\.path) == ["/work/game", "/work/art"])
    #expect(BlockedPushes.recent(entries, now: now, exists: { $0 != "/work/game" }).map(\.path) == ["/work/art"])
    #expect(BlockedPushes.recent(entries, now: now, limit: 1, exists: everything).map(\.path) == ["/work/game"])
    // Hidden until the repository is blocked again.
    let dismissed = ["/work/game": date("2026-10-20T13:55:00Z")]
    #expect(BlockedPushes.recent(entries, now: now, dismissed: dismissed, exists: everything).map(\.path) == ["/work/art"])
    let stale = ["/work/game": date("2026-10-20T10:00:00Z")]
    #expect(BlockedPushes.recent(entries, now: now, dismissed: stale, exists: everything).map(\.path) == ["/work/game", "/work/art"])
}

@Test func findsTheRecordWhereTheCliWritesIt() throws {
    let home = URL(fileURLWithPath: "/Users/me", isDirectory: true)
    #expect(BlockedPushes.fileURL(environment: [:], home: home).path == "/Users/me/.config/yunbox/blocked-pushes.json")
    #expect(BlockedPushes.fileURL(environment: ["XDG_CONFIG_HOME": "/xdg"], home: home).path == "/xdg/yunbox/blocked-pushes.json")
    #expect(BlockedPushes.fileURL(environment: ["XDG_CONFIG_HOME": "/xdg", "YUNBOX_CONFIG_DIR": "/custom"], home: home).path == "/custom/blocked-pushes.json")

    let directory = FileManager.default.temporaryDirectory.appending(path: "yunbox-blocked-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = BlockedPushes.fileURL(environment: ["YUNBOX_CONFIG_DIR": directory.path], home: home)
    #expect(BlockedPushes.load(from: url).isEmpty)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data(record.utf8).write(to: url)
    #expect(BlockedPushes.load(from: url).count == 3)
}
