import Foundation
import Testing
@testable import YunBoxKit

private let frozenJSON = #"""
{"schemaVersion":1,"windows":[{"window":"Mo-Fr 09:00-18:00","scope":"shared","timeZone":"Asia/Shanghai"},{"window":"Sa,Su 00:00-24:00","scope":"global"}],"messages":{"shared":"工作时间禁止推送"},"check":{"status":"frozen","weekday":"mon","time":"11:30","timeZone":"Asia/Shanghai","window":"Mo-Fr 09:00-18:00","scope":"shared","message":"工作时间禁止推送","until":{"weekday":"mon","time":"18:00","daysAhead":0}},"hook":"none","week":[{"weekday":"mon","date":"2026-10-19","spans":[{"start":"09:00","end":"12:00"},{"start":"13:30","end":"18:00"}]},{"weekday":"sat","date":"2026-10-24","spans":[{"start":"00:00","end":"24:00"}]}]}
"""#

@Test func decodesFreezeStatus() throws {
    let status = try FreezeStatus.decode(Data(frozenJSON.utf8), exitCode: 0)
    #expect(status.check.isFrozen)
    #expect(status.check.opensLabel == "18:00 后可以推送")
    #expect(status.check.scope == .shared)
    #expect(status.isUnenforced)
    #expect(status.windows(in: .shared).map(\.window) == ["Mo-Fr 09:00-18:00"])
    #expect(status.windows(in: .global).first?.timeZone == nil)
    #expect(status.message(in: .shared) == "工作时间禁止推送")
    #expect(FreezeStatus.Scope.shared.flag == ["--shared"])
    #expect(FreezeStatus.Scope.system.flag == nil)
    #expect(status.projectWindows.map(\.window) == ["Mo-Fr 09:00-18:00"])
    #expect(status.machineWindows.map(\.window) == ["Sa,Su 00:00-24:00"])
    #expect(status.week?.first?.frozenMinutes == 450)
    #expect(status.week?.first?.label == "周一")
    #expect(status.week?.last?.spans.first?.endMinute == 1440)
}

@Test func labelsWhenPushingOpensAgain() throws {
    let tomorrow = frozenJSON.replacingOccurrences(of: #""daysAhead":0"#, with: #""daysAhead":1"#)
    #expect(try FreezeStatus.decode(Data(tomorrow.utf8), exitCode: 0).check.opensLabel == "明天 18:00 后可以推送")
    let monday = frozenJSON.replacingOccurrences(of: #""daysAhead":0"#, with: #""daysAhead":3"#)
    #expect(try FreezeStatus.decode(Data(monday.utf8), exitCode: 0).check.opensLabel == "周一 18:00 后可以推送")
    let forever = frozenJSON.replacingOccurrences(of: #","until":{"weekday":"mon","time":"18:00","daysAhead":0}"#, with: #","until":null"#)
    #expect(try FreezeStatus.decode(Data(forever.utf8), exitCode: 0).check.opensLabel == "接下来 7 天都不能推送")
}

@Test func decodesAllowedStatusOutsideRepositoriesAndSurfacesCliErrors() throws {
    let allowed = #"{"schemaVersion":1,"windows":[],"messages":{},"check":{"status":"allowed","weekday":"tue","time":"09:00"},"hook":null}"#
    let status = try FreezeStatus.decode(Data(allowed.utf8), exitCode: 0)
    #expect(!status.check.isFrozen)
    #expect(status.hook == nil)
    #expect(!status.isUnenforced)
    do {
        _ = try FreezeStatus.decode(Data("错误：本仓库 .git/config 的 yunbox.pushFreeze：格式不对\n".utf8), exitCode: 2)
        Issue.record("Expected a CLI error")
    } catch let error as InspectionFailure {
        #expect(error.localizedDescription == "本仓库 .git/config 的 yunbox.pushFreeze：格式不对")
    }
    #expect(throws: InspectionFailure.self) { try FreezeStatus.decode(Data("{}".utf8), exitCode: 0) }
}

@Test func decodesPausesAndLabelsWhenTheyEnd() throws {
    let paused = #"{"schemaVersion":1,"windows":[{"window":"24/7","scope":"shared"}],"messages":{},"check":{"status":"paused","weekday":"tue","time":"15:00","window":"24/7","scope":"shared","pause":{"scope":"local","until":"2026-10-20T08:30:00.000Z"}},"hook":"inspect","pauses":[{"scope":"local","until":"2026-10-20T08:30:00.000Z"},{"scope":"global","until":null}]}"#
    let status = try FreezeStatus.decode(Data(paused.utf8), exitCode: 0)
    #expect(status.check.isPaused)
    #expect(!status.check.isFrozen)
    #expect(status.pause(in: .global)?.until == nil)
    let pause = try #require(status.check.pause)
    #expect(pause.scope == .local)
    let end = try #require(pause.untilDate)
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    #expect(pause.label(now: end.addingTimeInterval(-3600), calendar: calendar).hasPrefix("至 今天 "))
    #expect(pause.label(now: end.addingTimeInterval(-86_400), calendar: calendar).hasPrefix("至 明天 "))
    #expect(status.pause(in: .global)?.label() == "直到重新开启")
    #expect(FreezePauseOption.all.last?.arguments == [])
}

