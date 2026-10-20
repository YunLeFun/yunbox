import Foundation
import Testing
@testable import YunBoxKit

private let doctorJSON = #"""
{"schemaVersion":1,"status":"failed","mode":"cos","location":{"bucket":"team-assets-1250000000","region":"ap-shanghai","prefix":"yunbox/game"},"steps":[{"status":"pass","title":"git","detail":"2.55.0"},{"status":"fail","title":"COS 密钥","detail":"这台电脑还没有配置腾讯云密钥","fixes":["yunbox login"]}]}
"""#

@Test func decodesDoctorReportsForBothExitCodes() throws {
    let report = try DoctorReport.decode(Data(doctorJSON.utf8), exitCode: 1)
    #expect(report.mode == .cos)
    #expect(report.location?.label == "team-assets-1250000000（ap-shanghai）/yunbox/game/")
    #expect(!report.isHealthy)
    #expect(report.needsLogin)
    #expect(report.failures.map(\.title) == ["COS 密钥"])
    let healthy = doctorJSON.replacingOccurrences(of: #""status":"failed""#, with: #""status":"ok""#)
    #expect(try DoctorReport.decode(Data(healthy.utf8), exitCode: 0).isHealthy)
    #expect(throws: InspectionFailure.self) { try DoctorReport.decode(Data(doctorJSON.utf8), exitCode: 2) }
    #expect(throws: InspectionFailure.self) { try DoctorReport.decode(Data("not json".utf8), exitCode: 0) }
}

@Test func decodesBucketListingsAndKeepsErrorCodes() throws {
    let ok = #"{"schemaVersion":1,"status":"ok","buckets":[{"name":"a-1250000000","region":"ap-guangzhou"}]}"#
    #expect(try BucketListing.decode(Data(ok.utf8)) == [CosBucket(name: "a-1250000000", region: "ap-guangzhou")])
    let missing = #"{"schemaVersion":1,"status":"error","error":{"code":"NO_CREDENTIALS","message":"本机还没有配置腾讯云 COS 密钥"}}"#
    do {
        _ = try BucketListing.decode(Data(missing.utf8))
        Issue.record("Expected a listing error")
    } catch let error as BucketListingError {
        #expect(error.needsLogin)
        #expect(error.localizedDescription == "本机还没有配置腾讯云 COS 密钥")
    }
}

@Test func feedsStandardInputAndCanMergeStandardError() async throws {
    let result = try await ProcessRunner.run(
        executable: URL(fileURLWithPath: "/bin/sh"),
        arguments: ["-c", "read secret; printf 'got %s' \"$secret\"; printf ' oops' >&2"],
        directory: FileManager.default.temporaryDirectory, environment: [:],
        input: Data("s3cret\n".utf8), mergeStandardError: true
    )
    #expect(String(decoding: result.data, as: UTF8.self) == "got s3cret oops")
    let quiet = try await ProcessRunner.run(
        executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "printf out; printf err >&2"],
        directory: FileManager.default.temporaryDirectory, environment: [:]
    )
    #expect(String(decoding: quiet.data, as: UTF8.self) == "out")
}

@Test func recognisesTheStepMarksAtTheStartOfOutputLines() {
    let output = CommandOutput(exitCode: 1, text: "✓ git lfs install：已启用\n! .gitattributes：跳过 *.zip\n    建议：\n      git yunbox types add archive --renormalize\n✗ COS 密钥\n- hook：未安装\n错误：未知的素材类型：nope\n\n下一步：确认改动后提交\n")
    #expect(output.lines.map(\.mark) == [.pass, .warn, nil, nil, .fail, .skip, .error, nil, nil])
    #expect(output.lines[0].marker == "✓ ")
    #expect(output.lines[0].body == "git lfs install：已启用")
    #expect(output.lines[6].body == "未知的素材类型：nope")
    // Indented fix lines keep their indentation and get no mark.
    #expect(output.lines[3].body == "      git yunbox types add archive --renormalize")
    #expect(output.lines.map { $0.marker + $0.body }.joined(separator: "\n") == output.text.trimmingCharacters(in: .newlines))
}

private let s3DoctorJSON = #"""
{"schemaVersion":1,"status":"failed","mode":"cos","provider":"s3","location":{"bucket":"game-assets","region":"auto","prefix":"yunbox/game","endpoint":"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"},"steps":[{"status":"pass","title":"S3 位置","detail":"game-assets"},{"status":"fail","title":"S3 密钥","detail":"这台电脑还没有配置 S3 密钥","fixes":["yunbox login --provider s3"]}]}
"""#

@Test func readsTheProviderAndTreatsOlderReportsAsCOS() throws {
    let s3 = try DoctorReport.decode(Data(s3DoctorJSON.utf8), exitCode: 1)
    #expect(s3.mode == .cos)
    #expect(s3.provider == .s3)
    #expect(s3.s3Service == .r2)
    #expect(s3.storageName == "R2")
    #expect(s3.storageFullName == "Cloudflare R2")
    #expect(s3.location?.label == "game-assets（0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com）/yunbox/game/")
    // The S3 key step is titled 「S3 密钥」, not 「COS 密钥」.
    #expect(s3.needsLogin)
    let cosTitled = s3DoctorJSON.replacingOccurrences(of: "S3 密钥", with: "COS 密钥")
    #expect(try !DoctorReport.decode(Data(cosTitled.utf8), exitCode: 1).needsLogin)

    // A CLI from before S3 support sends no provider: COS.
    let old = try DoctorReport.decode(Data(doctorJSON.utf8), exitCode: 1)
    #expect(old.providerID == nil)
    #expect(old.provider == .cos)
    #expect(old.s3Service == nil)
    #expect(old.storageName == "COS")
    #expect(old.location?.endpoint == nil)
    let explicit = doctorJSON.replacingOccurrences(of: #""mode":"cos","#, with: #""mode":"cos","provider":"cos","#)
    #expect(try DoctorReport.decode(Data(explicit.utf8), exitCode: 1).provider == .cos)
    // A provider this app does not know still decodes, without a login form.
    let future = s3DoctorJSON.replacingOccurrences(of: #""provider":"s3""#, with: #""provider":"gcs""#)
    let unknown = try DoctorReport.decode(Data(future.utf8), exitCode: 1)
    #expect(unknown.provider == nil)
    #expect(unknown.storageName == "GCS")
    #expect(!unknown.needsLogin)
}

@Test func namesS3ServicesByEndpoint() {
    #expect(S3Service(endpoint: "https://abc.r2.cloudflarestorage.com") == .r2)
    #expect(S3Service(endpoint: "https://s3.eu-west-1.amazonaws.com") == .aws)
    #expect(S3Service(endpoint: "https://minio.example.com") == .minio)
    #expect(S3Service(endpoint: "http://127.0.0.1:9000") == .custom)
    #expect(S3Service(endpoint: nil) == .custom)
    let local = DoctorReport.Location(bucket: "assets", region: "us-east-1", prefix: "", endpoint: "http://127.0.0.1:9000")
    #expect(local.label == "assets（127.0.0.1:9000）/")
}

@Test func buildsInitArgumentsForEachS3Service() {
    var setup = S3Setup(service: .r2, accountID: " 0123456789ABCDEF0123456789ABCDEF ", bucket: "game-assets", prefix: "yunbox/game")
    #expect(setup.problem == nil)
    #expect(setup.initArguments == ["--provider", "s3", "--preset", "r2", "--account-id", "0123456789abcdef0123456789abcdef", "--bucket", "game-assets", "--prefix", "yunbox/game", "--yes"])
    setup.accountID = "not-an-id"
    #expect(setup.problem != nil)

    let aws = S3Setup(service: .aws, region: "eu-west-1", bucket: "b", prefix: "p")
    #expect(aws.initArguments == ["--provider", "s3", "--preset", "aws", "--region", "eu-west-1", "--bucket", "b", "--prefix", "p", "--yes"])
    let minio = S3Setup(service: .minio, endpoint: "http://127.0.0.1:9000", bucket: "b", prefix: "")
    #expect(minio.problem == nil)
    #expect(minio.initArguments == ["--provider", "s3", "--preset", "minio", "--endpoint", "http://127.0.0.1:9000", "--bucket", "b", "--prefix", "", "--yes"])
    let custom = S3Setup(service: .custom, endpoint: "https://s3.example.com", region: "eu-1", bucket: "b", prefix: "p")
    #expect(custom.initArguments == ["--provider", "s3", "--endpoint", "https://s3.example.com", "--region", "eu-1", "--bucket", "b", "--prefix", "p", "--yes"])
    // Plain http only for this machine; a bucket is always needed.
    #expect(S3Setup(service: .custom, endpoint: "http://s3.example.com", bucket: "b").problem != nil)
    #expect(S3Setup(service: .minio, endpoint: "http://localhost:9000", bucket: "b").problem == nil)
    #expect(S3Setup(service: .minio, endpoint: "https://minio.example.com").problem != nil)
}

@Test func loginSendsTheSecretOnlyOnStandardInput() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "yunbox-login-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    // Stands in for node: records its arguments and standard input.
    let fake = directory.appending(path: "node")
    try "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$(dirname \"$0\")/args\"\ncat > \"$(dirname \"$0\")/stdin\"\necho '✓ 已保存'\n".write(to: fake, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fake.path)
    let client = InspectionClient(node: fake, cli: URL(fileURLWithPath: "/app/cli.mjs"))

    let s3 = try await client.login(provider: .s3, secretId: "AKIAEXAMPLE", secretKey: "s3cr3t-access-key-value", directory: directory)
    #expect(s3.succeeded)
    #expect(try String(contentsOf: directory.appending(path: "args"), encoding: .utf8) == "/app/cli.mjs\nlogin\n--provider\ns3\n--secret-id\nAKIAEXAMPLE\n--secret-key-stdin\n")
    #expect(try String(contentsOf: directory.appending(path: "stdin"), encoding: .utf8) == "s3cr3t-access-key-value")
    // COS keeps the command older CLIs understand.
    _ = try await client.login(secretId: "AKIDEXAMPLE", secretKey: "cos-secret-key-value", directory: directory)
    #expect(try String(contentsOf: directory.appending(path: "args"), encoding: .utf8) == "/app/cli.mjs\nlogin\n--secret-id\nAKIDEXAMPLE\n--secret-key-stdin\n")
}
