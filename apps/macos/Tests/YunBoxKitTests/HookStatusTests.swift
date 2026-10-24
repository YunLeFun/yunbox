import Foundation
import Testing
@testable import YunBoxKit

@Test func setupDistinguishesEffectiveProtectionFromAnOverriddenGlobalHook() throws {
    let json = #"{"version":1,"repository":true,"hook":"inspect","scope":"global","confirm":true,"globalInstalled":true,"customPath":false,"node":"24.14.0","nodeReady":true,"git":{"found":true,"version":"2.55.0"},"lfs":{"found":true,"version":"3.7.1"},"ready":true}"#
    let enabled = try HookStatus.decode(Data(json.utf8), exitCode: 0)
    #expect(enabled.isProtected)
    #expect(enabled.confirm)
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
