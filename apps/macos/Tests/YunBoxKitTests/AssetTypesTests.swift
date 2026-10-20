import Foundation
import Testing
@testable import YunBoxKit

private let typesJSON = #"""
{"schemaVersion":1,"status":"ok","categories":[{"id":"texture","label":"贴图和图片","state":"lfs","extensions":[{"extension":"png","pattern":"*.png","lfs":true,"managed":true,"files":2,"lfsFiles":1},{"extension":"jpg","pattern":"*.jpg","lfs":true,"managed":true,"files":0,"lfsFiles":0}]},{"id":"audio","label":"音频","state":"partial","extensions":[{"extension":"wav","pattern":"*.wav","lfs":true,"managed":false,"files":1,"lfsFiles":1},{"extension":"mp3","pattern":"*.mp3","lfs":false,"managed":false,"files":0,"lfsFiles":0}]},{"id":"archive","label":"压缩包","state":"none","extensions":[{"extension":"zip","pattern":"*.zip","lfs":false,"managed":false,"files":2,"lfsFiles":0}]}],"presets":[{"id":"design","label":"设计稿","categories":["texture"]},{"id":"media","label":"图片和音视频","categories":["texture","audio"]}],"plainFiles":[{"path":"HERO.PNG","category":"texture","extension":"PNG","reason":"case"},{"path":"build/a.zip","category":"archive","extension":"zip","reason":"no-rule"},{"path":"build/b.zip","category":"archive","extension":"zip","reason":"no-rule"}]}
"""#

@Test func decodesAssetTypesAndSummarizesEachCategory() throws {
    let report = try AssetTypesReport.decode(Data(typesJSON.utf8), exitCode: 0)
    let texture = try #require(report.categories.first)
    #expect(texture.state == .lfs)
    #expect(texture.files == 2 && texture.lfsFiles == 1)
    #expect(texture.hasManagedRules)
    let audio = report.categories[1]
    #expect(audio.state == .partial)
    #expect(audio.trackedCount == 1)
    #expect(audio.otherRuleCount == 1)
    // Only a rule from another source: nothing `types remove` could delete.
    #expect(!audio.hasManagedRules)
    #expect(report.isApplied(report.presets[0]))
    #expect(!report.isApplied(report.presets[1]))
}

@Test func groupsPlainFilesByReasonThenCategory() throws {
    let report = try AssetTypesReport.decode(Data(typesJSON.utf8), exitCode: 0)
    let groups = report.plainFileGroups
    #expect(groups.map(\.reason) == [.case, .noRule])
    #expect(groups[0].parts.map(\.category.id) == ["texture"])
    #expect(groups[1].parts.map(\.category.id) == ["archive"])
    #expect(groups[1].parts[0].files.map(\.path) == ["build/a.zip", "build/b.zip"])
    #expect(groups[1].count == 2)
}

@Test func keepsTheCLIsLabelForUnknownTypes() throws {
    let json = typesJSON.replacingOccurrences(of: #""id":"archive","label":"压缩包""#, with: #""id":"engine","label":"引擎资源""#)
    let report = try AssetTypesReport.decode(Data(json.utf8), exitCode: 0)
    #expect(report.categories[2].title == "引擎资源")
    // Plain files of a type the app does not know still group under it.
    let unknown = json.replacingOccurrences(of: #""category":"archive""#, with: #""category":"engine""#)
    #expect(try AssetTypesReport.decode(Data(unknown.utf8), exitCode: 0).plainFileGroups[1].parts[0].category.title == "引擎资源")
}

@Test func showsTheMessageOfAnErrorObject() {
    let json = #"{"schemaVersion":1,"status":"error","error":{"code":"TYPES_FAILED","message":"当前目录不在 Git 仓库里"}}"#
    do {
        _ = try AssetTypesReport.decode(Data(json.utf8), exitCode: 1)
        Issue.record("Expected the CLI's error")
    } catch {
        #expect(error.localizedDescription == "当前目录不在 Git 仓库里")
    }
    #expect(throws: InspectionFailure.self) { try AssetTypesReport.decode(Data(typesJSON.utf8), exitCode: 1) }
    #expect(throws: InspectionFailure.self) {
        try AssetTypesReport.decode(Data(typesJSON.replacingOccurrences(of: #""schemaVersion":1"#, with: #""schemaVersion":2"#).utf8), exitCode: 0)
    }
    #expect(throws: InspectionFailure.self) { try AssetTypesReport.decode(Data("not json".utf8), exitCode: 0) }
}

@Test(.enabled(if: ProcessInfo.processInfo.environment["YUNBOX_TEST_NODE"] != nil && ProcessInfo.processInfo.environment["YUNBOX_TEST_CLI"] != nil))
func addsAndRemovesAssetTypesThroughBundledCLI() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let node = env["YUNBOX_TEST_NODE"], let cli = env["YUNBOX_TEST_CLI"] else { return }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("yunbox-types-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    var gitEnvironment = env
    gitEnvironment["HOME"] = root.path
    gitEnvironment["GIT_CONFIG_GLOBAL"] = "/dev/null"
    gitEnvironment["GIT_CONFIG_NOSYSTEM"] = "1"
    gitEnvironment["GIT_AUTHOR_NAME"] = "YunBox Test"
    gitEnvironment["GIT_AUTHOR_EMAIL"] = "test@example.invalid"
    gitEnvironment["GIT_COMMITTER_NAME"] = "YunBox Test"
    gitEnvironment["GIT_COMMITTER_EMAIL"] = "test@example.invalid"
    for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] { gitEnvironment.removeValue(forKey: key) }
    try Data("zip".utf8).write(to: root.appendingPathComponent("pack.zip"))
    func git(_ arguments: [String]) async throws -> String {
        let result = try await ProcessRunner.run(executable: URL(fileURLWithPath: "/usr/bin/git"), arguments: arguments,
            directory: root, environment: gitEnvironment)
        #expect(result.exitCode == 0, "git \(arguments.joined(separator: " "))")
        return String(decoding: result.data, as: UTF8.self)
    }
    for arguments in [["init", "-q"], ["add", "."], ["commit", "-qm", "feat: add fixture"]] { _ = try await git(arguments) }

    let client = InspectionClient(node: URL(fileURLWithPath: node), cli: URL(fileURLWithPath: cli))
    let before = try await client.assetTypes(repository: root)
    #expect(before.categories.allSatisfy { $0.state == .none })
    #expect(before.plainFileGroups.map(\.reason) == [.noRule])

    let design = try await client.addAssetTypes(repository: root, ids: ["design"])
    #expect(design.succeeded, "\(design.text)")
    let added = try await client.assetTypes(repository: root)
    #expect(added.categories.first { $0.id == "texture" }?.state == .lfs)
    #expect(added.isApplied(try #require(added.presets.first { $0.id == "design" })))

    let moved = try await client.addAssetTypes(repository: root, ids: ["archive"], renormalize: true)
    #expect(moved.succeeded, "\(moved.text)")
    #expect(try await git(["diff", "--cached", "--name-only"]) == ".gitattributes\npack.zip\n")
    #expect(try await client.assetTypes(repository: root).plainFiles.isEmpty)

    let removed = try await client.removeAssetTypes(repository: root, ids: ["texture"])
    #expect(removed.succeeded, "\(removed.text)")
    #expect(try await client.assetTypes(repository: root).categories.first { $0.id == "texture" }?.state == AssetTypesReport.Category.State.none)

    let unknown = try await client.addAssetTypes(repository: root, ids: ["nope"])
    #expect(unknown.exitCode == 2)
    #expect(unknown.text.contains("未知的素材类型：nope"))
}
