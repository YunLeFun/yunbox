import Foundation

/// A prompt the user pastes into an AI coding assistant (Claude Code, Codex, Cursor…) so it can connect a
/// repository to YunBox with the non-interactive CLI. Keys never pass through the assistant.
public enum AIOnboarding {
    /// - Parameters:
    ///   - repository: the Git repository to connect.
    ///   - report: the latest `yunbox doctor --json`, to tell the assistant where things stand.
    ///   - node, cli: the app's bundled CLI, for shells where `yunbox` is not on PATH.
    public static func prompt(repository: URL, report: DoctorReport?, node: URL?, cli: URL?) -> String {
        var command = "yunbox"
        var commandNote = String(localized: "如果终端里没有 yunbox 命令，可以先 npm install -g yunbox（需要 Node.js 22.18+）。")
        if let node, let cli {
            command = "\(shellQuote(node.path)) \(shellQuote(cli.path))"
            commandNote = String(localized: "下面命令里的 YB 请替换为云匣客户端自带的 CLI：\(command)；终端里已经有 yunbox 命令时，也可以直接用 yunbox / git yunbox。")
        }
        let yb = node != nil && cli != nil ? "YB" : "yunbox"
        let gitYb = node != nil && cli != nil ? "YB" : "git yunbox"
        let repositoryPath = repository.path
        let currentStatus = status(report)
        // A named key: the whole prompt is one translation unit.
        return String(localized: "ai.onboardingPrompt", defaultValue: """
        请帮我把这个 Git 仓库接入云匣 YunBox（Git LFS 素材直传我自己的腾讯云 COS，不需要服务端），并安装推送检查。

        仓库：\(repositoryPath)
        当前状态：\(currentStatus)
        \(commandNote)

        按顺序做，每一步先读 JSON 结果再决定下一步：
        1. 在仓库目录运行 `\(yb) doctor --json` 查看现状；不清楚的选项看 `\(gitYb) init --help`。
        2. 如果报告缺少 COS 密钥（标题为「COS 密钥」的失败项）：停下来，请我自己在终端运行 `\(yb) login`，或在云匣客户端的「COS 直连」面板里保存。不要向我索要 SecretId / SecretKey，也不要把密钥写进命令行参数、文件或仓库。
        3. 运行 `\(yb) buckets --json` 列出可用的 bucket，和我确认用哪个 bucket 和目录前缀（默认 yunbox/<owner>/<repo>）；需要新建 bucket 时先问我。
        4. 运行 `\(gitYb) init --bucket <名称-APPID> --region <地域> --prefix <前缀> --yes`（新建 bucket 再加 --create）。
        5. 再运行 `\(yb) doctor --json`，确认没有失败项；有失败项时按其中的 fixes 处理或告诉我。
        6. 运行 `\(yb) hook install`，让 pre-push 在上传前检查体积和禁推时段。
        7. 问我是否需要禁推时段；需要时用 `\(yb) freeze set "Mo-Fr 09:00-18:00"`（团队共享加 --shared），再用 `\(yb) freeze check --json` 核对。写法见 `\(yb) freeze --help`。
        8. 把 .gitattributes、.yunbox/config 的改动给我看，由我决定是否提交；不要 git push，也不要改动已有提交。
        """, comment: "Pasted into an AI coding assistant; keep the commands and placeholders exactly.")
    }

    static func status(_ report: DoctorReport?) -> String {
        guard let report else { return String(localized: "还没有检查，请先运行 doctor") }
        let failures = report.failures.map(\.title)
        switch report.mode {
        case .cos where report.isHealthy:
            return String(localized: "已直连 COS（\(report.location?.label ?? "")），检查全部通过；只需确认推送检查和禁推时段")
        case .cos:
            return String(localized: "已直连 COS（\(report.location?.label ?? "")），需要处理：\(failures.formatted(.list(type: .and)))")
        case .server:
            return String(localized: "使用 YunBox 服务端（lfs.url）；改成直连 COS 需要 git yunbox init --force，先和我确认")
        case .none:
            // The "YunBox" failure is the not-connected state itself.
            let others = failures.filter { $0 != "YunBox" }
            return others.isEmpty ? String(localized: "未接入") : String(localized: "未接入；另外需要处理：\(others.formatted(.list(type: .and)))")
        }
    }

    static func shellQuote(_ value: String) -> String {
        value.range(of: #"^[\w%+,./:=@-]+$"#, options: .regularExpression) != nil ? value : "'\(value.replacingOccurrences(of: "'", with: #"'\''"#))'"
    }
}
