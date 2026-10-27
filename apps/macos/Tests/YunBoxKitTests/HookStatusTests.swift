import Foundation
import Testing
@testable import YunBoxKit

@Test func hookSetupPassesTheSelectedConfirmationPolicyToTheCLI() async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "yunbox-hook-options-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let script = root.appending(path: "cli.sh")
    try Data("#!/bin/sh\nprintf '%s\\n' \"$@\"\n".utf8).write(to: script)
    let client = InspectionClient(node: URL(fileURLWithPath: "/bin/sh"), cli: script)
    let always = try await client.installHook(repository: root, compatible: true, confirmAlways: true)
    #expect(always.text == "hook\ninstall\n--confirm-mode\nalways\n--compatible\n")
    let exceeded = try await client.installHook(repository: root)
    #expect(exceeded.text == "hook\ninstall\n--confirm-mode\nexceeded\n")
    let disabled = try await client.installHook(repository: root, confirm: false, confirmAlways: true)
    #expect(disabled.text == "hook\ninstall\n--no-confirm\n")
    let repaired = try await client.repairHook(repository: root, confirmAlways: true)
    #expect(repaired.text == "hook\nrepair\n--confirm-mode\nalways\n")
}

@Test func setupDistinguishesEffectiveProtectionFromAnOverriddenGlobalHook() throws {
    let json = #"{"version":1,"repository":true,"hook":"inspect","scope":"global","confirm":true,"globalInstalled":true,"customPath":false,"node":"24.14.0","nodeReady":true,"git":{"found":true,"version":"2.55.0"},"lfs":{"found":true,"version":"3.7.1"},"ready":true}"#
    let enabled = try HookStatus.decode(Data(json.utf8), exitCode: 0)
    #expect(enabled.isProtected)
    #expect(enabled.confirm)
    #expect(enabled.confirmAlways == nil)
    let always = json.replacingOccurrences(of: #""confirm":true"#, with: #""confirm":true,"confirmAlways":true"#)
    #expect(try HookStatus.decode(Data(always.utf8), exitCode: 0).confirmAlways == true)
    let overridden = json.replacingOccurrences(of: #""hook":"inspect""#, with: #""hook":"none""#)
        .replacingOccurrences(of: #""customPath":false"#, with: #""customPath":true"#)
    let status = try HookStatus.decode(Data(overridden.utf8), exitCode: 0)
    #expect(status.globalInstalled)
    #expect(status.customPath)
    #expect(!status.isProtected)
    #expect(throws: InspectionFailure.self) { try HookStatus.decode(Data(json.utf8), exitCode: 1) }
    #expect(throws: InspectionFailure.self) {
        try HookStatus.decode(Data(json.replacingOccurrences(of: #""version":1"#, with: #""version":2"#).utf8), exitCode: 0)
    }
}

@Test func coverageCountsEffectiveProtectionAndCompatibilityWithoutAssumingGlobalCoverage() throws {
    let base = #"{"version":1,"repository":true,"hook":"none","confirm":true,"globalInstalled":true,"customPath":true,"node":"24.14.0","nodeReady":true,"git":{"found":true},"lfs":{"found":true},"ready":true}"#
    func status(_ compatibility: String?, protected: Bool = false) throws -> HookStatus {
        var json = base
        if let compatibility {
            json = String(json.dropLast()) + ",\"compatibility\":" + compatibility + "}"
        }
        if protected { json = json.replacingOccurrences(of: #""hook":"none""#, with: #""hook":"inspect""#) }
        return try HookStatus.decode(Data(json.utf8), exitCode: 0)
    }
    let active = try status(#"{"registered":true,"state":"active","originalPath":".husky/_"}"#, protected: true)
    let pending = try status(#"{"registered":false,"state":"pending"}"#)
    let overwritten = try status(#"{"registered":true,"state":"overridden"}"#)
    let missing = try status(#"{"registered":true,"state":"missing","missing":"dependencies"}"#)
    let coverage = HookCoverage(statuses: [active, pending, overwritten, missing], unavailable: 2)
    #expect(active.isProtected)
    #expect(!missing.isProtected)
    #expect(overwritten.isOverridden)
    #expect(pending.needsCompatibility)
    #expect(coverage.protected == 1)
    #expect(coverage.pending == 1)
    #expect(coverage.overridden == 1)
    #expect(coverage.unprotected == 1)
    #expect(coverage.unavailable == 2)
}
