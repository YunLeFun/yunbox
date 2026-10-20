import Foundation

/// Pages of the YunBox website (docs/ in the repository) the app links to.
public enum DocsPage: String, CaseIterable, Sendable, Identifiable {
    case quickStart = "guide/"
    case macOS = "guide/macos"
    case freeze = "guide/freeze"
    case freezeSyntax = "guide/freeze#时段写法"
    case freezeQuickOff = "guide/freeze#快速关闭"
    case ai = "guide/ai"
    case inspect = "inspect"
    case changelog = "changelog"

    public static let site = URL(string: "https://yunlefun.github.io/yunbox/")!
    public static let repository = URL(string: "https://github.com/YunLeFun/yunbox")!

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .quickStart: String(localized: "快速开始")
        case .macOS: String(localized: "macOS 客户端")
        case .freeze: String(localized: "禁推时段")
        case .freezeSyntax: String(localized: "时段写法")
        case .freezeQuickOff: String(localized: "快速关闭")
        case .ai: String(localized: "用 AI 编程助手接入")
        case .inspect: String(localized: "推送体积检查")
        case .changelog: String(localized: "更新日志")
        }
    }

    /// Pages the site also has in English, under `en/`; the rest of the site is Chinese only.
    public static let englishPages: Set<DocsPage> = [.changelog]

    /// The page in the interface's language where the site has it.
    public var url: URL { url(english: AppLanguage.interfaceIsEnglish) }

    public func url(english: Bool) -> URL {
        var components = URLComponents(url: Self.site, resolvingAgainstBaseURL: false)!
        let parts = rawValue.split(separator: "#", maxSplits: 1).map(String.init)
        components.path += (english && Self.englishPages.contains(self) ? "en/" : "") + parts[0]
        components.fragment = parts.count > 1 ? parts[1] : nil
        return components.url!
    }
}
