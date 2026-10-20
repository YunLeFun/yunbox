import SwiftUI
import UniformTypeIdentifiers
import YunBoxKit

struct SettingsView: View {
    @Bindable var updater: UpdaterStore
    @AppStorage("overrideLimits") private var overrideLimits = false
    @AppStorage("gitLimit") private var gitLimit = "900k"
    @AppStorage("lfsLimit") private var lfsLimit = "100m"
    @AppStorage("fileLimit") private var fileLimit = "10m"
    @AppStorage("nodePath") private var nodePath = ""
    @AppStorage("showMenuBarExtra") private var showMenuBarExtra = true
    @State private var choosingNode = false
    @State private var language = AppLanguage.stored(domain: AppRelauncher.bundleIdentifier)

    var body: some View {
        Form {
            Section("语言") {
                Picker("界面语言", selection: $language) {
                    Text("跟随系统").tag(AppLanguage.system)
                    ForEach(AppLanguage.allCases.filter { $0 != .system }) { language in
                        Text(verbatim: language.nativeName ?? language.rawValue).tag(language)
                    }
                }
                .onChange(of: language) { AppLanguage.store(language, domain: AppRelauncher.bundleIdentifier) }
                if language != AppRelauncher.launchLanguage {
                    HStack {
                        Text("重新打开云匣后生效。").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if AppRelauncher.canRelaunch { Button("立即重新打开") { AppRelauncher.relaunch() } }
                    }
                } else {
                    Text("也可以在「系统设置 → 通用 → 语言与地区 → 应用程序」中为云匣单独设置。命令行输出的说明暂时只有中文。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("检查预算") {
                Toggle("为客户端单独设置预算", isOn: $overrideLimits)
                if overrideLimits {
                    TextField("Git pack", text: $gitLimit)
                    TextField("LFS 候选总量", text: $lfsLimit)
                    TextField("单个文件", text: $fileLimit)
                    Text("支持字节或 k / m / g，均按 1024 进制。更改将在下次检查生效。")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("遵循仓库和全局的 YunBox Git 配置；未配置时使用 900 KiB / 100 MiB / 10 MiB。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("软件更新") {
                if updater.isAvailable {
                    Toggle("自动检查更新", isOn: $updater.automaticallyChecksForUpdates)
                    Toggle("自动下载并安装更新", isOn: $updater.automaticallyDownloadsUpdates)
                        .disabled(!updater.automaticallyChecksForUpdates)
                    HStack {
                        Text(updateDescription).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("立即检查") { updater.checkForUpdates() }.disabled(!updater.canCheckForUpdates)
                    }
                } else {
                    Text("当前版本 \(updater.currentVersion)。这份构建没有配置更新源，不会自动更新。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Link("查看更新日志", destination: DocsPage.changelog.url).font(.callout)
            }
            Section("菜单栏") {
                Toggle("在菜单栏显示禁推状态", isOn: $showMenuBarExtra)
                Text("图标显示当前仓库现在能否推送，点开可以查看和快捷设置禁推时段（yunbox freeze）。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Node.js 运行环境") {
                TextField("可执行文件路径（留空自动查找）", text: $nodePath)
                HStack {
                    Button("选择 Node.js…") { choosingNode = true }
                    Button("恢复自动查找") { nodePath = "" }.disabled(nodePath.isEmpty)
                }
                Text(runtimeDescription).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Text("应用内置 YunBox 检查组件，使用本机 Node.js 运行。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 540, height: 700)
        .fileImporter(isPresented: $choosingNode, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { nodePath = url.path }
        }
    }

    private var updateDescription: String {
        guard let date = updater.lastUpdateCheckDate else {
            return String(localized: "当前版本 \(updater.currentVersion)。更新包经过签名校验，安装时会重新打开应用。")
        }
        let checked = date.formatted(date: .abbreviated, time: .shortened)
        return String(localized: "当前版本 \(updater.currentVersion)，上次检查于 \(checked)。更新包经过签名校验，安装时会重新打开应用。")
    }

    private var runtimeDescription: String {
        if let client = try? InspectionClient.bundled(nodeOverride: nodePath) { return String(localized: "当前：\(client.node.path)") }
        return String(localized: "未找到可用的 Node.js。请选择已安装的 node 可执行文件。")
    }
}
