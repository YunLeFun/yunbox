import Foundation
import Testing
@testable import YunBoxKit

private let reportJSON = #"""
{"schemaVersion":1,"status":"exceeded","limits":{"gitBytes":921600,"lfsBytes":104857600,"fileBytes":10485760},"warnings":["本地快照"],"git":{"packBytes":10485761,"packComplete":false,"packCapBytes":10485760,"exceedsLimit":true,"blobBytes":2048,"blobCount":1,"pointerBytes":0,"files":[{"oid":"git-id","bytes":2048,"paths":["folder/hello\nworld.txt"],"exceedsFileLimit":false}]},"lfs":{"candidateBytes":125829120,"candidateCount":1,"remoteChecked":false,"uploadBytes":null,"exceedsLimit":true,"files":[{"oid":"lfs-id","bytes":125829120,"paths":["assets/角色.psd","copies/角色.psd"],"exceedsFileLimit":true}]}}
"""#

@Test func decodesExceededReportAndPreservesUnknownUploadSize() throws {
    let result = try InspectionResult.decode(Data(reportJSON.utf8), exitCode: 1)
    #expect(result.report.lfs.uploadBytes == nil)
    #expect(result.report.git.packComplete == false)
    #expect(result.report.files.map(\.kind) == [.lfs, .git])
    #expect(result.report.files[0].object.paths.count == 2)
    #expect(result.report.files[0].matches("角色"))
    #expect(result.report.files[1].path.contains("\n"))
    #expect(result.json == Data(reportJSON.utf8))
}

@Test func decodesLFSObjectsAlreadyInCOS() throws {
    let json = #"{"schemaVersion":1,"status":"ok","limits":{"gitBytes":921600,"lfsBytes":104857600,"fileBytes":10485760},"warnings":[],"git":{"packBytes":10,"packComplete":true,"packCapBytes":10485760,"exceedsLimit":false,"blobBytes":0,"blobCount":0,"pointerBytes":0,"files":[]},"lfs":{"candidateBytes":3072,"candidateCount":2,"remoteChecked":true,"uploadBytes":1024,"exceedsLimit":false,"files":[{"oid":"b","bytes":2048,"paths":["b.psd"],"exceedsFileLimit":false,"onRemote":true},{"oid":"c","bytes":1024,"paths":["c.psd"],"exceedsFileLimit":false,"onRemote":false}]}}"#
    let report = try InspectionResult.decode(Data(json.utf8), exitCode: 0).report
    #expect(report.lfs.remoteChecked)
    #expect(report.lfs.uploadBytes == 1024)
    #expect(report.lfs.remoteCount == 1)
    #expect(report.files.map(\.object.onRemote) == [true, false])
    #expect(try InspectionResult.decode(Data(reportJSON.utf8), exitCode: 1).report.files.allSatisfy { $0.object.onRemote == nil })
}

@Test func rejectsSchemaMismatchAndInconsistentExitCode() {
    #expect(throws: InspectionFailure.self) { try InspectionResult.decode(Data(reportJSON.utf8), exitCode: 0) }
    #expect(throws: InspectionFailure.self) { try InspectionResult.decode(Data(reportJSON.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":2").utf8), exitCode: 1) }
    #expect(throws: InspectionFailure.self) { try InspectionResult.decode(Data("not-json".utf8), exitCode: 0) }
}

@Test func showsStructuredCLIError() {
    let json = #"{"schemaVersion":1,"status":"error","error":{"code":"INSPECTION_FAILED","message":"无效的 Git 引用"}}"#
    do {
        _ = try InspectionResult.decode(Data(json.utf8), exitCode: 2)
        Issue.record("Expected a structured failure")
    } catch {
        #expect(error.localizedDescription == "无效的 Git 引用")
    }
}

@Test func labelsBinaryBudgetsUnambiguously() {
    #expect(byteLabel(0) == "0 B")
    #expect(byteLabel(921600) == "900 KiB")
    #expect(byteLabel(104857600) == "100 MiB")
}

@Test func passesArgumentsWithoutShellInterpolation() async throws {
    let text = "file with spaces; $(echo unsafe) ' 引号"
    let result = try await ProcessRunner.run(executable: URL(fileURLWithPath: "/bin/sh"),
        arguments: ["-c", "printf '%s' \"$1\"", "fixture", text], directory: FileManager.default.temporaryDirectory,
        environment: [:])
    #expect(String(data: result.data, encoding: .utf8) == text)
    #expect(result.exitCode == 0)
}

@Test func cancelsRunningChild() async throws {
    let task = Task {
        try await ProcessRunner.run(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["10"],
            directory: FileManager.default.temporaryDirectory, environment: [:])
    }
    try await Task.sleep(for: .milliseconds(100))
    task.cancel()
    do {
        _ = try await task.value
        Issue.record("Expected cancellation")
    } catch {
        #expect(error is CancellationError)
    }
}

@Test func boundsRunTimeAndOutput() async {
    do {
        _ = try await ProcessRunner.run(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["10"],
            directory: FileManager.default.temporaryDirectory, environment: [:], timeout: 0.1)
        Issue.record("Expected timeout")
    } catch {
        #expect(error.localizedDescription.contains("120 秒"))
    }
    do {
        _ = try await ProcessRunner.run(executable: URL(fileURLWithPath: "/usr/bin/yes"), arguments: [],
            directory: FileManager.default.temporaryDirectory, environment: [:], outputLimit: 1024)
        Issue.record("Expected output bound")
    } catch {
        #expect(error.localizedDescription.contains("报告超过"))
    }
}

@Test(.enabled(if: ProcessInfo.processInfo.environment["YUNBOX_TEST_NODE"] != nil && ProcessInfo.processInfo.environment["YUNBOX_TEST_CLI"] != nil))
func inspectsRealRepositoryThroughBundledCLI() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let node = env["YUNBOX_TEST_NODE"], let cli = env["YUNBOX_TEST_CLI"] else { return }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("yunbox-native-\(UUID().uuidString)")
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
    try Data("version https://git-lfs.github.com/spec/v1\noid sha256:\(String(repeating: "a", count: 64))\nsize 2097152\n".utf8)
        .write(to: root.appendingPathComponent("asset.psd"))
    for arguments in [["init", "-q"], ["add", "."], ["commit", "-qm", "feat: add fixture"]] {
        let result = try await ProcessRunner.run(executable: URL(fileURLWithPath: "/usr/bin/git"), arguments: arguments,
            directory: root, environment: gitEnvironment)
        #expect(result.exitCode == 0)
    }
    let client = InspectionClient(node: URL(fileURLWithPath: node), cli: URL(fileURLWithPath: cli))
    let result = try await client.inspect(repository: root, limits: ["--file-limit", "1k", "--git-limit", "10m", "--lfs-limit", "100m"])
    #expect(result.report.status == "exceeded")
    #expect(result.report.lfs.candidateBytes == 2097152)
    #expect(result.report.lfs.files.first?.paths == ["asset.psd"])
    #expect(result.report.git.files.isEmpty)
}
