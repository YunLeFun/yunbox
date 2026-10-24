import SwiftUI
import UniformTypeIdentifiers
import YunBoxKit

struct SettingsView: View {
    @Environment(\.openWindow) private var openWindow
    @Bindable var updater: UpdaterStore
    let inspector: InspectorStore
    @AppStorage("overrideLimits") private var overrideLimits = false
    @AppStorage(BudgetSetting.git.key) private var gitLimit = BudgetSetting.git.defaultValue.argument
    @AppStorage(BudgetSetting.lfs.key) private var lfsLimit = BudgetSetting.lfs.defaultValue.argument
    @AppStorage(BudgetSetting.file.key) private var fileLimit = BudgetSetting.file.defaultValue.argument
    @AppStorage("nodePath") private var nodePath = ""
    @AppStorage("showMenuBarExtra") private var showMenuBarExtra = true
    @State private var choosingNode = false
    /// Budgets changed since the current repository was last checked.
    @State private var budgetsChanged = false
    @State private var language = AppLanguage.stored(domain: AppRelauncher.bundleIdentifier)

    var body: some View {
        Form {
            Section("推送保护") {
                Button("打开新手引导…") {
                    openWindow(id: "main")
                    inspector.showingOnboarding = true
                }
                Text("检查运行环境，选择仓库，并管理当前仓库或全局的推送保护。")
                    .font(.caption).foregroundStyle(.secondary)
            }
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
                    BudgetRow(title: "Git pack", setting: .git, raw: $gitLimit)
                    BudgetRow(title: "LFS 候选总量", setting: .lfs, raw: $lfsLimit)
                    BudgetRow(title: "单个文件", setting: .file, raw: $fileLimit)
                    HStack {
                        Text("按 1024 进制计算，也可以直接输入 900k、2m 这样的大小。")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("全部恢复默认") { resetBudgets() }.disabled(budgetsAreDefault)
                    }
                } else {
                    Text("遵循仓库和全局的 YunBox Git 配置；未配置时使用 900 KiB / 100 MiB / 10 MiB。")
                        .font(.caption).foregroundStyle(.secondary)
                    if let usedLimits {
                        Text(usedLimits).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if needsRecheck, let repository = inspector.repository {
                    HStack {
                        Label("预算已更改，下次检查时生效。", systemImage: "info.circle")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("重新检查「\(repository.lastPathComponent)」") { inspector.inspect() }
                            .disabled(inspector.isInspecting)
                    }
                }
            }
            .onChange(of: [overrideLimits.description, gitLimit, lfsLimit, fileLimit]) { budgetsChanged = true }
            .onChange(of: inspector.isInspecting) { if inspector.isInspecting { budgetsChanged = false } }
            .onChange(of: inspector.repository) { budgetsChanged = false }
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
                TextField("可执行文件路径", text: $nodePath, prompt: Text("自动查找"))
                HStack {
                    Button("选择 Node.js…") { choosingNode = true }
                    Button("恢复自动查找") { nodePath = "" }.disabled(nodePath.isEmpty)
                }
                runtimeStatus
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

    private var runtimeStatus: some View {
        let client = try? InspectionClient.bundled(nodeOverride: nodePath)
        return Label {
            if let client {
                Text("当前：\(client.node.path)").textSelection(.enabled)
            } else {
                Text("未找到可用的 Node.js。请选择已安装的 node 可执行文件。")
            }
        } icon: {
            Image(systemName: client == nil ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(client == nil ? .orange : .green)
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    /// With the app's own budgets the last report shows whether they changed; Git config can't be compared.
    private var needsRecheck: Bool {
        guard budgetsChanged else { return false }
        guard overrideLimits, let limits = inspector.result?.report.limits else { return true }
        let current = zip(BudgetSetting.allCases, [gitLimit, lfsLimit, fileLimit])
            .map { (ByteBudget(parsing: $1) ?? $0.defaultValue).bytes }
        return current != [limits.gitBytes, limits.lfsBytes, limits.fileBytes]
    }

    private var budgetsAreDefault: Bool {
        zip(BudgetSetting.allCases, [gitLimit, lfsLimit, fileLimit])
            .allSatisfy { ByteBudget(parsing: $1) == $0.defaultValue }
    }

    private func resetBudgets() {
        gitLimit = BudgetSetting.git.defaultValue.argument
        lfsLimit = BudgetSetting.lfs.defaultValue.argument
        fileLimit = BudgetSetting.file.defaultValue.argument
    }

    /// What the current repository's last check actually used, so following Git config isn't a guess.
    private var usedLimits: String? {
        guard let repository = inspector.repository, let limits = inspector.result?.report.limits else { return nil }
        return String(localized: "「\(repository.lastPathComponent)」上次检查使用 \(byteLabel(limits.gitBytes)) / \(byteLabel(limits.lfsBytes)) / \(byteLabel(limits.fileBytes))。")
    }
}

/// One budget: a number, a 1024-based unit, and a menu of common values.
private struct BudgetRow: View {
    let title: LocalizedStringKey
    let setting: BudgetSetting
    @Binding var raw: String
    @State private var text = ""
    @FocusState private var editing: Bool

    private var budget: ByteBudget { ByteBudget(parsing: raw) ?? setting.defaultValue }

    var body: some View {
        LabeledContent(title) {
            HStack(spacing: 6) {
                TextField(title, text: $text)
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    .frame(width: 88)
                    .focused($editing)
                    .onChange(of: text) { accept(text) }
                    .onSubmit { text = String(budget.amount) }
                Picker(title, selection: Binding { budget.unit } set: { raw = ByteBudget(clamping: budget.amount, $0).argument }) {
                    ForEach(ByteBudget.Unit.allCases) { Text(verbatim: $0.label).tag($0) }
                }
                .labelsHidden()
                .frame(width: 72)
                Menu {
                    ForEach(setting.presets, id: \.self) { preset in
                        Toggle(isOn: Binding { budget == preset } set: { _ in raw = preset.argument }) {
                            if preset == setting.defaultValue {
                                Text("\(preset.label)（默认）")
                            } else {
                                Text(verbatim: preset.label)
                            }
                        }
                    }
                    Divider()
                    Button("恢复默认") { raw = setting.defaultValue.argument }.disabled(budget == setting.defaultValue)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("常用值")
                .accessibilityLabel("常用值")
            }
        }
        .onAppear { text = String(budget.amount) }
        // Presets, unit changes and resets arrive through raw; typing that is still in progress stays as typed.
        .onChange(of: raw) { if Int64(text) != budget.amount { text = String(budget.amount) } }
        .onChange(of: editing) { if !editing { text = String(budget.amount) } }
        if budget.bytes < 1024 {
            Label("只有 \(budget.label)，是否选错了单位？", systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.orange)
        }
    }

    /// Keeps digits as the amount; a typed or pasted size with a unit ("2m", "900 KiB") sets both.
    private func accept(_ input: String) {
        if input.contains(where: \.isLetter), let parsed = ByteBudget(parsing: input.replacingOccurrences(of: " ", with: "")) {
            raw = parsed.argument
            text = String(parsed.amount)
            return
        }
        let digits = String(input.compactMap { $0.wholeNumberValue.flatMap { $0 < 10 ? Character(String($0)) : nil } })
        if digits != input { text = digits; return }
        if let amount = Int64(digits) { raw = ByteBudget(clamping: amount, budget.unit).argument }
    }
}
