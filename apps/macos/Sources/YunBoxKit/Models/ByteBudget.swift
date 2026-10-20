import Foundation

/// A size budget as the CLI reads it: a whole number with an optional 1024-based unit ("900k", "100m").
public struct ByteBudget: Equatable, Hashable, Sendable {
    public enum Unit: String, CaseIterable, Identifiable, Sendable {
        case bytes = "", kib = "k", mib = "m", gib = "g"

        public var id: String { rawValue }

        public var label: String {
            switch self {
            case .bytes: "B"
            case .kib: "KiB"
            case .mib: "MiB"
            case .gib: "GiB"
            }
        }

        public var multiplier: Int64 {
            switch self {
            case .bytes: 1
            case .kib: 1 << 10
            case .mib: 1 << 20
            case .gib: 1 << 30
            }
        }
    }

    /// The CLI keeps budgets below JavaScript's largest safe integer.
    public static let maxBytes: Int64 = 9_007_199_254_740_990

    public var amount: Int64
    public var unit: Unit

    public init(_ amount: Int64, _ unit: Unit) {
        self.amount = amount
        self.unit = unit
    }

    /// Keeps a typed amount within what the CLI accepts for this unit.
    public init(clamping amount: Int64, _ unit: Unit) {
        self.init(min(max(amount, 0), Self.maxBytes / unit.multiplier), unit)
    }

    /// Accepts what `yunbox inspect` accepts: bytes, or k/m/g and KiB/MiB/GiB in any case.
    public init?(parsing text: String) {
        let scanned = text.trimmingCharacters(in: .whitespaces).lowercased()
        let digits = scanned.prefix { $0.isASCII && $0.isNumber }
        let suffix = scanned.dropFirst(digits.count)
        guard !digits.isEmpty, let amount = Int64(digits) else { return nil }
        let unit: Unit? = switch suffix {
        case "", "b": .bytes
        case "k", "kib": .kib
        case "m", "mib": .mib
        case "g", "gib": .gib
        default: nil
        }
        guard let unit, amount <= Self.maxBytes / unit.multiplier else { return nil }
        self.init(amount, unit)
    }

    /// The form stored in settings and passed to the CLI.
    public var argument: String { "\(amount)\(unit.rawValue)" }
    public var bytes: Int64 { amount * unit.multiplier }
    public var label: String { "\(amount) \(unit.label)" }
}

/// The three inspection budgets the app can override, with the CLI's defaults.
public enum BudgetSetting: String, CaseIterable, Identifiable, Sendable {
    case git, lfs, file

    public var id: String { rawValue }

    /// UserDefaults key; kept from the free-text fields so existing settings carry over.
    public var key: String { "\(rawValue)Limit" }
    public var flag: String { "--\(rawValue)-limit" }

    public var defaultValue: ByteBudget {
        switch self {
        case .git: ByteBudget(900, .kib)
        case .lfs: ByteBudget(100, .mib)
        case .file: ByteBudget(10, .mib)
        }
    }

    public var presets: [ByteBudget] {
        switch self {
        case .git: [ByteBudget(512, .kib), ByteBudget(900, .kib), ByteBudget(2, .mib), ByteBudget(10, .mib)]
        case .lfs: [ByteBudget(50, .mib), ByteBudget(100, .mib), ByteBudget(500, .mib), ByteBudget(1, .gib)]
        case .file: [ByteBudget(5, .mib), ByteBudget(10, .mib), ByteBudget(50, .mib), ByteBudget(100, .mib)]
        }
    }

    /// The stored budget, or the default when nothing (or something the CLI would reject) is stored.
    public func value(in defaults: UserDefaults) -> ByteBudget {
        defaults.string(forKey: key).flatMap(ByteBudget.init(parsing:)) ?? defaultValue
    }

    /// CLI arguments for the app's own budgets; empty when the app follows Git config.
    public static func arguments(in defaults: UserDefaults, overriding: Bool) -> [String] {
        guard overriding else { return [] }
        return allCases.flatMap { [$0.flag, $0.value(in: defaults).argument] }
    }
}
