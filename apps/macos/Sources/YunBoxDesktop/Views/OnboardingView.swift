import SwiftUI
import UniformTypeIdentifiers
import YunBoxKit

/// A repeatable setup flow: local tools, repository, push protection, optional storage.
struct OnboardingView: View {
    @Bindable var inspector: InspectorStore
    @State private var setup = OnboardingStore()
    @State private var step = 0
    @State private var choosingRepository = false
    @State private var clearingMissing = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Image(systemName: "shippingbox.fill").font(.largeTitle).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 4) {
                    Text("开始使用云匣").font(.title2.bold())
                    Text("检查推送体积，让素材上传更安心。").foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(step + 1) / 4").monospacedDigit().foregroundStyle(.secondary)
            }
            ProgressView(value: Double(step + 1), total: 4)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch step {
                    case 0: environment
                    case 1: repository
                    case 2: protection
                    default: storage
                    }
                    if let error = setup.error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                Button("稍后设置") { dismiss() }.disabled(setup.busy)
                Spacer()
                if step > 0 { Button("上一步") { step -= 1 }.disabled(setup.busy) }
                if step < 3 {
                    Button(step == 2 && setup.status?.isProtected != true ? "暂不启用，继续" : "下一步") { step += 1 }
                        .keyboardShortcut(.defaultAction).disabled(!canAdvance || setup.busy)
                } else {
                    Button("开始使用") {
                        UserDefaults.standard.set(true, forKey: "onboardingCompleted")
                        dismiss()
                    }.keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(28)
        .frame(width: 620, height: 540)
        .task(id: inspector.repository?.path) { await setup.refresh(inspector: inspector) }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if !setup.busy && !setup.scanning { Task { await setup.refresh(inspector: inspector, updateOptions: false) } }
        }
        .confirmationDialog("清理失效的本机钩子配置？", isPresented: $clearingMissing) {
            Button("清理失效配置", role: .destructive) { Task { await setup.install(inspector: inspector, action: .clearMissing) } }
        } message: {
            Text("仅在确认项目已不再使用这个钩子目录时清理。若尚未安装依赖，请先恢复依赖，再重新检查。")
        }
        .fileImporter(isPresented: $choosingRepository, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result, !inspector.select(url) {
                setup.error = String(localized: "请选择 Git 仓库文件夹。")
            }
        }
    }

    private var canAdvance: Bool {
        switch step {
        case 0: setup.status?.ready == true
        case 1: setup.status?.repository == true
        default: true
        }
    }

    private var environment: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("检查运行环境").font(.headline)
            Text("云匣内置命令行组件，需要本机的 Node.js、Git 和 Git LFS。")
            if let status = setup.status {
                toolRow("Node.js", value: status.node, found: status.nodeReady)
                toolRow("Git", value: status.git.version ?? status.git.reason ?? "—", found: status.git.found)
                toolRow("Git LFS", value: status.lfs.version ?? status.lfs.reason ?? "—", found: status.lfs.found)
                if !status.ready {
                    Text("需要 Node.js 22.18+、24.11+ 或 26+，Git 2.30+ 和 Git LFS 3.2+。安装或更新后，请重新检查。")
                        .font(.callout).foregroundStyle(.orange)
                }
            } else if setup.busy { ProgressView() }
            HStack {
                Button("重新检查") { Task { await setup.refresh(inspector: inspector) } }.disabled(setup.busy)
                SettingsLink { Text("打开设置") }
                Link("安装说明", destination: DocsPage.quickStart.url)
            }
        }
    }

    private var repository: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("选择一个 Git 仓库").font(.headline)
            Text("先检查现有项目。推送保护可以单独使用，无需配置云存储。")
            if let url = inspector.repository {
                Label(url.lastPathComponent, systemImage: "folder")
                Text(url.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Button("选择仓库…") { choosingRepository = true }.disabled(setup.busy)
        }
    }

    private var protection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("启用推送保护").font(.headline)
            Text("每次推送先检查体积和禁推时段，通过后才上传。关闭云匣后仍然生效。")
            Toggle("超限时询问是否继续", isOn: $setup.confirm)
            Text("macOS 弹出确认框；终端环境在终端询问。无人确认时取消推送，禁推时段始终阻止推送。")
                .font(.caption).foregroundStyle(.secondary)
            Toggle("启用全局保护（普通仓库）", isOn: $setup.globally)
            Text("默认只保护当前仓库。全局模式保留仓库原有钩子；仓库自定义钩子目录会覆盖全局设置。")
                .font(.caption).foregroundStyle(.secondary)
            Label(setup.status?.globalInstalled == true ? "全局开关已开启" : "全局开关未开启", systemImage: "globe")
                .font(.callout)
            if let compatibility = setup.status?.compatibility {
                switch compatibility.state {
                case "overridden":
                    Label("保护已被覆盖，请修复兼容接入。", systemImage: "exclamationmark.shield")
                        .foregroundStyle(.orange)
                case "modified":
                    Label("本机调度器已被修改，请检查后再接入。", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                case "pending":
                    Text("兼容接入会保留团队钩子，检查通过后才运行原 pre-push；其他钩子继续转发。")
                        .font(.callout)
                case "active":
                    Label("已兼容接入，团队钩子保持生效", systemImage: "link")
                default: EmptyView()
                }
                if let missing = compatibility.missing {
                    Text(missing == "dependencies" ? "原钩子目录不存在，可能尚未安装依赖。请恢复依赖后重新检查。" : "原钩子目录不存在。请恢复目录；确认是遗留配置后才清理。")
                        .font(.callout).foregroundStyle(.orange)
                }
                if let original = compatibility.originalPath {
                    Text(verbatim: original).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            if let status = setup.status, status.isProtected {
                Label(status.scope == "global" ? "当前仓库已受全局保护" : "当前仓库已启用推送保护", systemImage: "checkmark.shield")
                    .foregroundStyle(.green)
                Text(status.confirm ? "当前行为：超限询问" : "当前行为：超限直接阻止").font(.callout)
            } else {
                Label("当前仓库尚未启用 YunBox 推送保护", systemImage: "shield.slash").font(.callout)
            }
            HStack {
                if setup.status?.isOverridden == true {
                    Button("修复兼容接入") { Task { await setup.install(inspector: inspector, action: .repair) } }
                        .buttonStyle(.borderedProminent)
                } else {
                    Button(setup.status?.needsCompatibility == true ? "兼容接入当前仓库" : "应用保护设置") {
                        Task { await setup.install(inspector: inspector) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(setup.status?.repository != true || setup.status?.compatibility?.missing != nil || setup.status?.compatibility?.state == "modified")
                }
                if setup.status?.compatibility?.registered == true {
                    Button("恢复原钩子配置") { Task { await setup.install(inspector: inspector, action: .restore) } }
                } else if setup.status?.compatibility?.missing != nil {
                    Button("清理失效配置…") { clearingMissing = true }
                }
                Button("重新检查") { Task { await setup.refresh(inspector: inspector, updateOptions: false) } }
                    .disabled(setup.scanning)
            }
            HStack {
                if setup.status?.globalInstalled == true {
                    Button("移除全局保护") { Task { await setup.install(inspector: inspector, action: .removeGlobal) } }
                }
                Link("推送检查说明", destination: DocsPage.inspect.url)
            }
            Divider()
            Text("已知仓库：已保护 \(setup.coverage.protected) 个，\(setup.coverage.pending) 个待兼容接入")
                .font(.callout)
            Text("被覆盖 \(setup.coverage.overridden) 个，未启用 \(setup.coverage.unprotected) 个，无法读取 \(setup.coverage.unavailable) 个")
                .font(.caption).foregroundStyle(.secondary)
            Text("仅统计客户端已知仓库；全局开关开启不代表所有仓库都已受保护。安装依赖后请重新检查。")
                .font(.caption).foregroundStyle(.secondary)
            if setup.scanning { ProgressView("正在检查已知仓库…") }
            if !setup.attentionPaths.isEmpty {
                DisclosureGroup("查看需要处理的仓库") {
                    ForEach(setup.attentionPaths, id: \.self) { path in
                        Button { _ = inspector.select(URL(fileURLWithPath: path)) } label: {
                            Text(verbatim: path).font(.caption).lineLimit(1).truncationMode(.middle)
                        }.help(path)
                    }
                }
            }

        }
        .disabled(setup.busy)
    }

    private var storage: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("接入素材存储（可选）").font(.headline)
            Text("把 Git LFS 素材存入自己的 COS、R2 或 S3 兼容存储。也可以稍后从仓库右上角的「存储」入口配置。")
            Button("配置素材存储…") {
                UserDefaults.standard.set(true, forKey: "onboardingCompleted")
                inspector.openStorageAfterOnboarding = true
                dismiss()
            }
            Text("可以随时从「帮助 → 新手引导…」重新打开这些步骤。")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    private func toolRow(_ title: String, value: String, found: Bool) -> some View {
        HStack {
            Image(systemName: found ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(found ? .green : .orange)
            Text(verbatim: title)
            Spacer()
            Text(verbatim: value).font(.callout).foregroundStyle(.secondary)
        }
    }
}
