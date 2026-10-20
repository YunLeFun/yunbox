import Foundation

/// The interface language: the system's choice, or one picked in Settings.
///
/// The choice is the app's own `AppleLanguages` default, the same one System Settings → General →
/// Language & Region → Applications writes, so both places stay in sync. macOS reads it at launch,
/// so a change takes effect after a relaunch.
public enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case system
    case simplifiedChinese = "zh-Hans"
    case english = "en"

    public var id: String { rawValue }

    /// The language's name in that language, so anyone can find theirs; `nil` for `.system`.
    public var nativeName: String? {
        switch self {
        case .system: nil
        case .simplifiedChinese: "简体中文"
        case .english: "English"
        }
    }

    static let key = "AppleLanguages"

    /// The language stored for the app in `domain` (its bundle identifier), ignoring the system-wide list
    /// that `UserDefaults` would otherwise fall back to.
    public static func stored(in defaults: UserDefaults = .standard, domain: String) -> AppLanguage {
        guard let first = (defaults.persistentDomain(forName: domain)?[key] as? [String])?.first else { return .system }
        if first.hasPrefix("zh") { return .simplifiedChinese }
        if first.hasPrefix("en") { return .english }
        return .system
    }

    /// Store the choice for the app; `.system` removes the override.
    public static func store(_ language: AppLanguage, in defaults: UserDefaults = .standard, domain: String) {
        var values = defaults.persistentDomain(forName: domain) ?? [:]
        values[key] = language == .system ? nil : [language.rawValue]
        defaults.setPersistentDomain(values, forName: domain)
    }

    /// Whether the running interface is English (and not Simplified Chinese, the source language).
    public static var interfaceIsEnglish: Bool {
        Bundle.main.preferredLocalizations.first?.hasPrefix("en") == true
    }
}
