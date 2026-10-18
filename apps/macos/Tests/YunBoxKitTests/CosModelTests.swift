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
