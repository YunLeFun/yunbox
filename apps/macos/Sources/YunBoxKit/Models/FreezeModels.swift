import Foundation

/// `yunbox freeze list --json`: every push freeze window, whether a push is allowed right now, and whether the
/// repository's pre-push wrapper enforces it.
public struct FreezeStatus: Decodable, Sendable, Equatable {
    /// Where a window is stored, as `git config --show-scope` names it, plus `shared` for `.yunbox/config`.
    public enum Scope: String, Decodable, Sendable, CaseIterable, Identifiable {
        case shared, local, worktree, global, system, command
        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .shared: String(localized: "团队 .yunbox/config")
            case .local: String(localized: "本仓库")
            case .worktree: String(localized: "本 worktree")
            case .global: String(localized: "全局（本机所有仓库）")
            case .system: String(localized: "系统 Git 配置")
            case .command: String(localized: "命令行 -c")
            }
        }

        /// The `yunbox freeze set` / `clear` flag that writes this scope; `nil` for scopes the CLI does not write.
        public var flag: [String]? {
            switch self {
            case .local: []
            case .shared: ["--shared"]
            case .global: ["--global"]
            default: nil
            }
        }
    }

    public struct Window: Decodable, Sendable, Equatable, Identifiable {
        /// Normalized `opening_hours` rules, e.g. `Mo-Fr 09:00-18:00`.
        public let window: String
        public let scope: Scope
        public let timeZone: String?
        public var id: String { "\(scope.rawValue)|\(window)" }
    }

    public struct Moment: Decodable, Sendable, Equatable {
        /// `mon` … `sun`.
        public let weekday: String
        /// `HH:MM`.
        public let time: String
        public let daysAhead: Int
    }

    /// `yunbox freeze off`: every window switched off until `until`, or until switched back on.
    public struct Pause: Decodable, Sendable, Equatable {
        public let scope: Scope
        /// ISO 8601; `nil` until `yunbox freeze on`.
        public let until: String?

        public var untilDate: Date? {
            guard let until else { return nil }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.date(from: until) ?? ISO8601DateFormatter().date(from: until)
        }

        /// "至 今天 16:30 自动恢复" or "直到重新开启".
        public func label(now: Date = Date(), calendar: Calendar = .current) -> String {
            guard let date = untilDate else { return String(localized: "直到重新开启") }
            let time = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
            let day: String
            if calendar.isDate(date, inSameDayAs: now) {
                day = String(localized: "今天")
            } else if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
                day = String(localized: "明天")
            } else {
                day = date.formatted(.dateTime.month(.abbreviated).day())
            }
            return String(localized: "至 \(day) \(time) 自动恢复")
        }
    }

    public struct Check: Decodable, Sendable, Equatable {
        public let status: String
        public let weekday: String
        public let time: String
        public let timeZone: String?
        public let window: String?
        public let scope: Scope?
        public let message: String?
        /// When pushing opens again; `nil` both when allowed and when no gap appears within 7 days.
        public let until: Moment?
        /// The pause in effect, if any.
        public let pause: Pause?

        public var isFrozen: Bool { status == "frozen" }
        /// A window would block now, but the windows are switched off.
        public var isPaused: Bool { status == "paused" }

        /// "18:00 后可以推送", "明天 00:00 后可以推送" or "接下来 7 天都不能推送".
        public var opensLabel: String {
            guard let until else { return String(localized: "接下来 7 天都不能推送") }
            switch until.daysAhead {
            case 0: return String(localized: "\(until.time) 后可以推送")
            case 1: return String(localized: "明天 \(until.time) 后可以推送")
            default: return String(localized: "\(Self.weekdayLabel(until.weekday)) \(until.time) 后可以推送")
            }
        }

        public static func weekdayLabel(_ weekday: String) -> String {
            let names = [
                "sun": String(localized: "周日"), "mon": String(localized: "周一"), "tue": String(localized: "周二"),
                "wed": String(localized: "周三"), "thu": String(localized: "周四"), "fri": String(localized: "周五"),
                "sat": String(localized: "周六"),
            ]
            return names[weekday] ?? weekday
        }
    }

    /// One local calendar day and its frozen stretches.
    public struct Day: Decodable, Sendable, Equatable, Identifiable {
        public struct Span: Decodable, Sendable, Equatable {
            /// `HH:MM`.
            public let start: String
            /// `HH:MM`, `24:00` for the end of the day.
            public let end: String

            /// Minutes after midnight, for drawing.
            public var startMinute: Int { Self.minutes(start) }
            public var endMinute: Int { Self.minutes(end) }

            static func minutes(_ clock: String) -> Int {
                let parts = clock.split(separator: ":").compactMap { Int($0) }
                return parts.count == 2 ? parts[0] * 60 + parts[1] : 0
            }
        }

        public let weekday: String
        public let date: String
        public let spans: [Span]
        public var id: String { date }
        public var label: String { Check.weekdayLabel(weekday) }
        /// Frozen minutes in the day.
        public var frozenMinutes: Int { spans.reduce(0) { $0 + $1.endMinute - $1.startMinute } }
    }

    /// What runs on pre-push: `inspect` enforces windows, `guard` and `none` do not.
    public enum Hook: String, Decodable, Sendable { case inspect, `guard`, none }

    public let schemaVersion: Int
    public let windows: [Window]
    public let messages: [String: String]
    public let check: Check
    /// `nil` outside a Git repository.
    public let hook: Hook?
    /// Today and the six days after it; absent from older CLIs.
    public let week: [Day]?
    /// Pauses still in effect, the repository's own first; absent from older CLIs.
    public let pauses: [Pause]?

    public func pause(in scope: Scope) -> Pause? { pauses?.first { $0.scope == scope } }

    /// Windows that belong to the repository itself (local or shared), not to this machine.
    public var projectWindows: [Window] { windows.filter { $0.scope == .local || $0.scope == .shared || $0.scope == .worktree } }
    /// Windows from `~/.gitconfig` and the system config, which apply to every repository.
    public var machineWindows: [Window] { windows.filter { $0.scope == .global || $0.scope == .system } }

    /// True when windows exist but this clone's pushes are not stopped by them.
    public var isUnenforced: Bool { !windows.isEmpty && hook != .inspect }

    public func windows(in scope: Scope) -> [Window] { windows.filter { $0.scope == scope } }

    public func message(in scope: Scope) -> String? { messages[scope.rawValue] }

    /// Decode the JSON object; on a non-zero exit the merged output is the CLI's own explanation.
    public static func decode(_ data: Data, exitCode: Int32) throws -> FreezeStatus {
        guard exitCode == 0 else {
            let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw InspectionFailure.cli(text.isEmpty ? String(localized: "无法读取禁推时段。") : text.replacingOccurrences(of: "错误：", with: ""))
        }
        guard let status = try? JSONDecoder().decode(FreezeStatus.self, from: data), status.schemaVersion == 1 else {
            throw InspectionFailure.invalidReport
        }
        return status
    }
}

/// How long `yunbox freeze off` lasts, as offered in the menu bar.
public struct FreezePauseOption: Sendable, Identifiable, Equatable {
    public let title: String
    /// `--for` / `--until` arguments; empty means until switched back on.
    public let arguments: [String]
    public var id: String { title }

    public static let all: [FreezePauseOption] = [
        FreezePauseOption(title: String(localized: "关闭 30 分钟"), arguments: ["--for", "30m"]),
        FreezePauseOption(title: String(localized: "关闭 1 小时"), arguments: ["--for", "1h"]),
        FreezePauseOption(title: String(localized: "关闭 2 小时"), arguments: ["--for", "2h"]),
        FreezePauseOption(title: String(localized: "关闭到今天结束"), arguments: ["--until", "24:00"]),
        FreezePauseOption(title: String(localized: "一直关闭，直到重新开启"), arguments: []),
    ]
}

/// One-click freeze rules offered in the menu bar, written exactly as `yunbox freeze list` normalizes them so a
/// scope holding one can be shown as checked.
public struct FreezePreset: Sendable, Identifiable, Equatable {
    public let title: String
    public let rules: String
    public var id: String { rules }

    public static let all: [FreezePreset] = [
        FreezePreset(title: String(localized: "工作时间"), rules: "Mo-Fr 09:00-18:00"),
        FreezePreset(title: String(localized: "工作时间（午休可推送）"), rules: "Mo-Fr 09:00-12:00,13:30-18:00"),
        FreezePreset(title: String(localized: "工作日全天"), rules: "Mo-Fr 00:00-24:00"),
        FreezePreset(title: String(localized: "周末"), rules: "Sa,Su 00:00-24:00"),
        FreezePreset(title: String(localized: "周五晚到周末"), rules: "Fr 18:00-24:00; Sa,Su 00:00-24:00"),
        FreezePreset(title: String(localized: "夜间"), rules: "22:00-08:00"),
    ]
}
