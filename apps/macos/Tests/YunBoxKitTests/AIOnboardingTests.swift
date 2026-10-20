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

@Test func docsLinksPointAtTheWebsite() {
    #expect(DocsPage.freeze.url.absoluteString == "https://yunlefun.github.io/yunbox/guide/freeze")
    #expect(DocsPage.quickStart.url.absoluteString == "https://yunlefun.github.io/yunbox/guide/")
    #expect(DocsPage.freezeSyntax.url.path == "/yunbox/guide/freeze")
    #expect(DocsPage.freezeSyntax.url.fragment(percentEncoded: false) == "时段写法")
}

@Test func everyDocsPageExistsInTheRepository() throws {
    let docs = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../../docs").standardizedFileURL
    for page in DocsPage.allCases {
        let path = String(page.rawValue.split(separator: "#")[0])
        let file = path.hasSuffix("/") ? "\(path)index.md" : "\(path).md"
        #expect(FileManager.default.fileExists(atPath: docs.appending(path: file).path), "\(file)")
        if let anchor = page.url.fragment(percentEncoded: false) {
            let text = try String(contentsOf: docs.appending(path: file), encoding: .utf8)
            #expect(text.contains("## \(anchor)\n"), "\(file)#\(anchor)")
        }
    }
}
