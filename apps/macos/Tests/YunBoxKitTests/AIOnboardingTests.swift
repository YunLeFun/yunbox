import Foundation
import Testing
@testable import YunBoxKit

@Test func onboardingPromptUsesTheBundledCLIAndKeepsKeysWithTheUser() throws {
    let report = try DoctorReport.decode(Data(#"{"schemaVersion":1,"status":"failed","mode":"none","steps":[{"status":"fail","title":"YunBox","detail":"没有接入"},{"status":"fail","title":"COS 密钥","detail":"没有密钥"}]}"#.utf8), exitCode: 1)
    let prompt = AIOnboarding.prompt(
        repository: URL(fileURLWithPath: "/Users/me/game assets"), report: report,
        node: URL(fileURLWithPath: "/opt/homebrew/bin/node"), cli: URL(fileURLWithPath: "/Applications/YunBox.app/Contents/Resources/cli/cli.mjs")
    )
    #expect(prompt.contains("仓库：/Users/me/game assets"))
    #expect(prompt.contains("当前状态：未接入；另外需要处理：COS 密钥"))
    #expect(prompt.contains("`YB login`"))
    #expect(prompt.contains("/opt/homebrew/bin/node /Applications/YunBox.app/Contents/Resources/cli/cli.mjs"))
    #expect(prompt.contains("`YB doctor --json`"))
    #expect(prompt.contains("不要向我索要 SecretId / SecretKey"))
    #expect(prompt.contains("不要 git push"))
    let plain = AIOnboarding.prompt(repository: URL(fileURLWithPath: "/tmp/r"), report: nil, node: nil, cli: nil)
    #expect(plain.contains("`yunbox doctor --json`"))
    #expect(plain.contains("`git yunbox init --bucket"))
    #expect(plain.contains("npm install -g yunbox"))
    #expect(AIOnboarding.shellQuote("/Applications/Yun Box.app") == "'/Applications/Yun Box.app'")
}

@Test func onboardingPromptFollowsTheStorageProvider() throws {
    let r2 = try DoctorReport.decode(Data(#"{"schemaVersion":1,"status":"ok","mode":"cos","provider":"s3","location":{"bucket":"game","region":"auto","prefix":"yunbox","endpoint":"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"},"steps":[]}"#.utf8), exitCode: 0)
    // A connected repository uses its own provider whatever the panel shows.
    let connected = AIOnboarding.prompt(repository: URL(fileURLWithPath: "/tmp/r"), report: r2, provider: .cos, node: nil, cli: nil)
    #expect(connected.contains("当前状态：已直连 Cloudflare R2（game（0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com）/yunbox/），检查全部通过"))
    #expect(connected.contains("`yunbox login --provider s3`"))
    #expect(connected.contains("`git yunbox init --preset r2 --account-id"))
    #expect(connected.contains("每个项目一个 bucket"))
    #expect(connected.contains("不要向我索要 Access Key ID / Secret Access Key"))
    #expect(!connected.contains("yunbox buckets"))
    // Not set up yet: the provider chosen in the panel.
    let none = try DoctorReport.decode(Data(#"{"schemaVersion":1,"status":"failed","mode":"none","steps":[{"status":"fail","title":"YunBox","detail":"没有接入"}]}"#.utf8), exitCode: 1)
    #expect(AIOnboarding.prompt(repository: URL(fileURLWithPath: "/tmp/r"), report: none, provider: .s3, node: nil, cli: nil).contains("--preset r2"))
    let cos = AIOnboarding.prompt(repository: URL(fileURLWithPath: "/tmp/r"), report: none, provider: .cos, node: nil, cli: nil)
    #expect(cos.contains("`yunbox buckets --json`"))
    #expect(cos.contains("「存储」面板"))
    // An older CLI's report has no provider: COS.
    let old = try DoctorReport.decode(Data(#"{"schemaVersion":1,"status":"ok","mode":"cos","location":{"bucket":"a-1250000000","region":"ap-guangzhou","prefix":"p"},"steps":[]}"#.utf8), exitCode: 0)
    let oldPrompt = AIOnboarding.prompt(repository: URL(fileURLWithPath: "/tmp/r"), report: old, provider: .s3, node: nil, cli: nil)
    #expect(oldPrompt.contains("已直连 腾讯云 COS（a-1250000000（ap-guangzhou）/p/）"))
    #expect(oldPrompt.contains("`yunbox buckets --json`"))
}

@Test func docsLinksPointAtTheWebsite() {
    #expect(DocsPage.freeze.url(english: false).absoluteString == "https://yunlefun.github.io/yunbox/guide/freeze")
    #expect(DocsPage.quickStart.url(english: false).absoluteString == "https://yunlefun.github.io/yunbox/guide/")
    #expect(DocsPage.freezeSyntax.url(english: false).path == "/yunbox/guide/freeze")
    #expect(DocsPage.freezeSyntax.url(english: false).fragment(percentEncoded: false) == "时段写法")
    #expect(DocsPage.changelog.url(english: false).absoluteString == "https://yunlefun.github.io/yunbox/changelog")
    #expect(DocsPage.changelog.url(english: true).absoluteString == "https://yunlefun.github.io/yunbox/en/changelog")
    // An English interface opens the English page, with its English anchor.
    #expect(DocsPage.quickStart.url(english: true).absoluteString == "https://yunlefun.github.io/yunbox/en/guide/")
    #expect(DocsPage.freezeSyntax.url(english: true).absoluteString == "https://yunlefun.github.io/yunbox/en/guide/freeze#window-syntax")
    #expect(DocsPage.inspect.url(english: true).absoluteString == "https://yunlefun.github.io/yunbox/en/inspect")
}

@Test func everyDocsPageExistsInTheRepository() throws {
    let docs = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../docs").standardizedFileURL
    for page in DocsPage.allCases {
        let path = String(page.rawValue.split(separator: "#")[0])
        let file = path.hasSuffix("/") ? "\(path)index.md" : "\(path).md"
        #expect(FileManager.default.fileExists(atPath: docs.appending(path: file).path), "\(file)")
        #expect(FileManager.default.fileExists(atPath: docs.appending(path: "en/\(file)").path), "en/\(file)")
        if let anchor = page.url(english: false).fragment(percentEncoded: false) {
            let text = try String(contentsOf: docs.appending(path: file), encoding: .utf8)
            #expect(text.contains("## \(anchor)\n"), "\(file)#\(anchor)")
        }
        // English headings get VitePress's slugs: lower case, spaces to hyphens.
        #expect((page.englishFragment == nil) == (page.url(english: false).fragment == nil), "\(page)")
        if let anchor = page.englishFragment {
            let text = try String(contentsOf: docs.appending(path: "en/\(file)"), encoding: .utf8)
            let slugs = text.split(separator: "\n").filter { $0.hasPrefix("## ") }.map { $0.dropFirst(3).lowercased().replacingOccurrences(of: " ", with: "-") }
            #expect(slugs.contains(anchor), "en/\(file)#\(anchor)")
        }
    }
}

@Test func languageChoiceIsTheAppsOwnAppleLanguages() throws {
    let domain = "fun.yunle.yunbox.tests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: domain))
    defer { defaults.removePersistentDomain(forName: domain) }
    #expect(AppLanguage.stored(in: defaults, domain: domain) == .system)
    AppLanguage.store(.english, in: defaults, domain: domain)
    #expect(defaults.persistentDomain(forName: domain)?["AppleLanguages"] as? [String] == ["en"])
    #expect(AppLanguage.stored(in: defaults, domain: domain) == .english)
    // System Settings may store a regional variant.
    defaults.setPersistentDomain(["AppleLanguages": ["zh-Hans-CN"], "other": 1], forName: domain)
    #expect(AppLanguage.stored(in: defaults, domain: domain) == .simplifiedChinese)
    AppLanguage.store(.system, in: defaults, domain: domain)
    #expect(defaults.persistentDomain(forName: domain)?["AppleLanguages"] == nil)
    #expect(defaults.persistentDomain(forName: domain)?["other"] as? Int == 1)
}
