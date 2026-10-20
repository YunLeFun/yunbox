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

    public static let site = URL(string: "https://yunlefun.github.io/yunbox/")!
    public static let repository = URL(string: "https://github.com/YunLeFun/yunbox")!

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .quickStart: "快速开始"
        case .macOS: "macOS 客户端"
        case .freeze: "禁推时段"
        case .freezeSyntax: "时段写法"
        case .freezeQuickOff: "快速关闭"
        case .ai: "用 AI 编程助手接入"
        case .inspect: "推送体积检查"
        }
    }

    public var url: URL {
        var components = URLComponents(url: Self.site, resolvingAgainstBaseURL: false)!
        let parts = rawValue.split(separator: "#", maxSplits: 1).map(String.init)
        components.path += parts[0]
        components.fragment = parts.count > 1 ? parts[1] : nil
        return components.url!
    }
}
