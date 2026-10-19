import CryptoKit
import Foundation
import Testing
@testable import YunBoxKit

private let lfsOid = String(repeating: "b", count: 64)
private let changesJSON = #"""
{"schemaVersion":1,"status":"ok","limits":{"gitBytes":921600,"lfsBytes":104857600,"fileBytes":10485760},"warnings":[],"changes":[{"path":"art/logo.png","status":"modified","storage":"lfs","beforeBytes":10,"afterBytes":20,"beforeOid":"\#(String(repeating: "a", count: 64))","afterOid":"\#(lfsOid)","versions":1,"pushBytes":20,"exceedsFileLimit":false},{"path":"gone.txt","status":"deleted","storage":"git","beforeBytes":3,"afterBytes":null,"beforeOid":"\#(String(repeating: "c", count: 40))","afterOid":null,"versions":0,"pushBytes":0,"exceedsFileLimit":false}],"git":{"packBytes":10,"packComplete":true,"packCapBytes":10485760,"exceedsLimit":false,"blobBytes":0,"blobCount":0,"pointerBytes":0,"files":[]},"lfs":{"candidateBytes":20,"candidateCount":1,"remoteChecked":false,"uploadBytes":null,"exceedsLimit":false,"files":[{"oid":"\#(lfsOid)","bytes":20,"paths":["art/logo.png"],"exceedsFileLimit":false}]}}
"""#

@Test func decodesChangesAndMatchesThemToFileRows() throws {
    let report = try InspectionResult.decode(Data(changesJSON.utf8), exitCode: 0).report
    #expect(report.changes?.count == 2)
    let row = try #require(report.files.first)
    let change = try #require(report.change(for: row))
    #expect(change.statusLabel == "修改")
    #expect(change.beforeOid == String(repeating: "a", count: 64))
    #expect(change.afterOid == lfsOid)
    #expect(report.changeIndex()[row.id]?.path == "art/logo.png")
    #expect(report.changes?[1].afterOid == nil)
}

@Test func decodesReportsFromCLIsWithoutChangesOrOids() throws {
    let old = changesJSON.replacing(#/"beforeOid":("[0-9a-f]+"|null),"afterOid":("[0-9a-f]+"|null),/#, with: "")
    #expect(!old.contains("Oid"))
    let report = try InspectionResult.decode(Data(old.utf8), exitCode: 0).report
    #expect(report.changes?.first?.beforeOid == nil)
    let older = old.replacing(#/"changes":\[.*\],"git"/#, with: #""git""#)
    #expect(try InspectionResult.decode(Data(older.utf8), exitCode: 0).report.changes == nil)
}

@Test func namesPreviewFilesSafely() {
    #expect(ContentReader.fileName(for: "art/logo.png", tag: "推送前") == "logo（推送前）.png")
    #expect(ContentReader.fileName(for: "README") == "README")
    #expect(ContentReader.fileName(for: "a/archive.tar.gz", tag: "推送后") == "archive.tar（推送后）.gz")
    #expect(ContentReader.fileName(for: "x/bad\u{1B}\nname.txt") == "bad__name.txt")
    #expect(ContentReader.fileName(for: "dir/..") == "file..")
    let long = ContentReader.fileName(for: String(repeating: "素", count: 200) + ".png", tag: "推送后")
    #expect(long.utf8.count <= 255)
    #expect(long.hasSuffix("（推送后）.png"))
}

@Test func readsPushedVersionsFromGitAndTheLFSStoreAndDiffsThem() async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "yunbox-content-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    var environment = toolEnvironment()
    environment["HOME"] = root.path
    environment["GIT_CONFIG_GLOBAL"] = "/dev/null"
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    let git = { (arguments: [String]) async throws -> String in
        let output = try await ProcessRunner.run(executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["git"] + arguments,
                                                 directory: root, environment: environment)
        #expect(output.exitCode == 0)
        return String(decoding: output.data, as: UTF8.self).trimmingCharacters(in: .newlines)
    }
    _ = try await git(["init", "-q"])
    let file = root.appending(path: "guide.md")
    try Data("one\ntwo\nthree\n".utf8).write(to: file)
    let before = try await git(["hash-object", "-w", "guide.md"])
    try Data("one\n2\nthree\n".utf8).write(to: file)
    let after = try await git(["hash-object", "-w", "guide.md"])
    // The worktree differs from both versions: the reader must not look at it.
    try Data("worktree\n".utf8).write(to: file)

    let reader = ContentReader(repository: root, environment: environment)
    let output = root.appending(path: "out", directoryHint: .isDirectory)
    let beforeFile = output.appending(path: "a/guide（推送前）.md")
    let afterFile = output.appending(path: "b/guide（推送后）.md")
    try await reader.export(oid: before, to: beforeFile)
    try await reader.export(oid: after, to: afterFile)
    #expect(try String(contentsOf: afterFile, encoding: .utf8) == "one\n2\nthree\n")
    #expect(ContentReader.kind(of: afterFile, path: "guide.md") == .text)
    let diff = try #require(try await reader.diff(before: beforeFile, after: afterFile))
    #expect(diff.hasPrefix("@@ -1,3 +1,3 @@"))
    #expect(diff.contains("\n-two\n+2\n"))
    #expect(!diff.contains(output.path))
    #expect(try await reader.diff(before: nil, after: afterFile)?.contains("+one") == true)

    let payload = Data([0x89, 0x50, 0x4E, 0x47, 0, 1, 2])
    let oid = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
    let store = root.appending(path: ".git/lfs/objects/\(oid.prefix(2))/\(oid.dropFirst(2).prefix(2))")
    try FileManager.default.createDirectory(at: store, withIntermediateDirectories: true)
    try payload.write(to: store.appending(path: oid))
    let image = output.appending(path: "c/logo.png")
    try await reader.export(oid: oid, to: image)
    #expect(try Data(contentsOf: image) == payload)
    #expect(ContentReader.kind(of: image, path: "art/logo.png") == .image)
    #expect(try await reader.diff(before: nil, after: image) == nil)

    await #expect(throws: ContentFailure.self) { try await reader.export(oid: String(repeating: "d", count: 64), to: output.appending(path: "missing")) }
    await #expect(throws: ContentFailure.self) { try await reader.export(oid: "../../etc/passwd", to: output.appending(path: "bad")) }
    #expect(try FileManager.default.contentsOfDirectory(atPath: output.appending(path: "c").path) == ["logo.png"])
}

@Test func pairsRemovedAndAddedLinesSideBySide() {
    let diff = SplitDiff(unified: """
    @@ -1,4 +1,5 @@ intro
     # Guide
    -one
    -two
    +1
     keep
    +new
    @@ -10,2 +11,2 @@
    -old
    \\ No newline at end of file
    +fresh

    """)
    let cell = { (number: Int, text: String, changed: Bool) in DiffCell(number: number, text: text, changed: changed) }
    #expect(diff.rows == [
        .hunk("@@ -1,4 +1,5 @@ intro"),
        .lines(left: cell(1, "# Guide", false), right: cell(1, "# Guide", false)),
        .lines(left: cell(2, "one", true), right: cell(2, "1", true)),
        .lines(left: cell(3, "two", true), right: nil),
        .lines(left: cell(4, "keep", false), right: cell(3, "keep", false)),
        .lines(left: nil, right: cell(4, "new", true)),
        .hunk("@@ -10,2 +11,2 @@"),
        .lines(left: cell(10, "old", true), right: nil),
        .note("\\ No newline at end of file"),
        .lines(left: nil, right: cell(11, "fresh", true)),
    ])
    #expect(diff.added == 3)
    #expect(diff.removed == 3)
    #expect(SplitDiff(unified: "").rows.isEmpty)
}
