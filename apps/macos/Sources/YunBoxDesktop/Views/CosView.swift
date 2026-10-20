import AppKit
import SwiftUI
import YunBoxKit

/// Header chip: whether this repository pushes LFS objects straight to COS, and whether that works.
struct CosStatusChip: View {
    @Bindable var store: InspectorStore

    var body: some View {
        Button { store.showingCos = true } label: {
            HStack(spacing: 6) {
                if store.isCheckingCos && store.cosReport == nil {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: symbol).foregroundStyle(tint)
                }
                Text(label).lineLimit(1)
            }
            .font(.callout)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(.quaternary, in: Capsule())
        }
        .buttonStyle(.plain)
        .help("COS 直连状态，点击查看检查结果和接入")
    }

    private var label: String {
        guard let report = store.cosReport else { return store.cosError == nil ? String(localized: "正在检查 COS…") : String(localized: "COS 状态未知") }
        switch report.mode {
        case .cos: return report.isHealthy ? String(localized: "直连 COS · 正常") : String(localized: "直连 COS · 需要处理")
        case .server: return report.isHealthy ? String(localized: "YunBox 服务端 · 正常") : String(localized: "YunBox 服务端 · 需要处理")
        case .none: return String(localized: "未接入 COS")
        }
    }

    private var symbol: String {
        guard let report = store.cosReport else { return "icloud.slash" }
        if report.mode == .none { return "icloud.and.arrow.up" }
        return report.isHealthy ? "checkmark.icloud" : "exclamationmark.icloud"
    }

    private var tint: Color {
        guard let report = store.cosReport, report.mode != .none else { return .secondary }
        return report.isHealthy ? .green : .orange
    }
}

/// Doctor results, `yunbox login` and `git yunbox init` for direct COS, without a terminal.
struct CosSheet: View {
    @Bindable var store: InspectorStore
    @Environment(\.dismiss) private var dismiss
    @State private var output: CommandOutput?
    @State private var running = false
    @State private var copiedPrompt = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("COS 直连").font(.title2.bold())
                Spacer()
                if store.isCheckingCos { ProgressView().controlSize(.small) }
                Button { copyAIPrompt() } label: {
                    Label(copiedPrompt ? "已复制" : "复制给 AI 的接入说明", systemImage: copiedPrompt ? "checkmark" : "sparkles")
                }
                .help("复制一段提示词，粘贴给 Claude Code、Codex 等编程助手，由它按步骤接入；密钥仍由你自己保存")
                Button("重新检查") { store.checkCos() }.disabled(store.isCheckingCos || running)
            }
            if let location = store.cosReport?.location {
                Label(location.label, systemImage: "externaldrive.connected.to.line.below")
                    .font(.callout).textSelection(.enabled)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let error = store.cosError {
                        Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    }
                    if let report = store.cosReport {
                        StepList(steps: report.steps)
                        if report.needsLogin {
                            Divider()
                            LoginForm(store: store, running: $running, output: $output)
                        } else if report.mode == .none {
                            Divider()
                            SetupForm(store: store, running: $running, output: $output)
                        } else if report.mode == .server {
                            Text("这个仓库使用 YunBox 服务端（lfs.url）。要改成直连 COS，请在终端运行 git yunbox init --force。")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    if let output {
                        Divider()
                        CommandOutputView(output: output)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .sheetScrollMargins()
            HStack {
                Text("密钥只保存在这台电脑上（钥匙串），仓库里只记录 bucket、地域和前缀。")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Link("接入说明", destination: DocsPage.quickStart.url).font(.callout)
                Link("AI 接入说明", destination: DocsPage.ai.url).font(.callout)
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 640, height: 680)
    }
}

extension CosSheet {
    /// Put a ready-to-paste prompt for an AI coding assistant on the clipboard.
    func copyAIPrompt() {
        guard let repository = store.repository else { return }
        let client = try? store.client()
        let prompt = AIOnboarding.prompt(repository: repository, report: store.cosReport, node: client?.node, cli: client?.cli)
        NSPasteboard.general.clearContents()
        copiedPrompt = NSPasteboard.general.setString(prompt, forType: .string)
        Task {
            try? await Task.sleep(for: .seconds(2))
            copiedPrompt = false
        }
    }
}

private struct StepList: View {
    let steps: [DoctorReport.Step]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(steps) { step in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: symbol(step.status)).foregroundStyle(tint(step.status))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(step.title).fontWeight(.medium)
                        if let detail = step.detail { Text(detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled) }
                        ForEach(step.fixes ?? [], id: \.self) { fix in
                            Text(fix).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }
                    }
                }
            }
        }
    }

    private func symbol(_ status: DoctorReport.Step.Status) -> String {
        switch status {
        case .pass: "checkmark.circle.fill"
        case .warn: "exclamationmark.circle.fill"
        case .fail: "xmark.circle.fill"
        case .skip: "minus.circle"
        }
    }

    private func tint(_ status: DoctorReport.Step.Status) -> Color {
        switch status {
        case .pass: .green
        case .warn: .orange
        case .fail: .red
        case .skip: .secondary
        }
    }
}

/// Saves the user's own SecretId / SecretKey with `yunbox login`; the key goes over stdin.
private struct LoginForm: View {
    let store: InspectorStore
    @Binding var running: Bool
    @Binding var output: CommandOutput?
    @State private var secretId = ""
    @State private var secretKey = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("保存腾讯云密钥").font(.headline)
            Text("用管理员分配给你的子账号密钥（yunbox policy 可以生成它需要的最小权限策略）。")
                .font(.callout).foregroundStyle(.secondary)
            TextField("SecretId", text: $secretId).textFieldStyle(.roundedBorder)
            SecureField("SecretKey", text: $secretKey).textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("保存") { save() }
                    .disabled(running || secretId.isEmpty || secretKey.isEmpty)
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func save() {
        guard let repository = store.repository else { return }
        running = true
        let id = secretId.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = secretKey.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { running = false }
            do {
                output = try await store.client().login(secretId: id, secretKey: key, directory: repository)
                if output?.succeeded == true {
                    secretKey = ""
                    store.checkCos()
                }
            } catch {
                output = CommandOutput(exitCode: -1, text: error.localizedDescription)
            }
        }
    }
}

/// Picks or creates a bucket and runs `git yunbox init` for direct COS.
private struct SetupForm: View {
    let store: InspectorStore
    @Binding var running: Bool
    @Binding var output: CommandOutput?
    @State private var buckets: [CosBucket] = []
    @State private var loadError: BucketListingError?
    @State private var loading = false
    @State private var choice = ""
    @State private var newName = ""
    @State private var newRegion = "ap-guangzhou"
    @State private var manualRegion = ""
    @State private var prefix = ""
    @State private var confirmingCreate = false
    private static let newBucket = "__new__"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("接入：把素材直传到 COS").font(.headline)
            if loading {
                // Inline like the header's spinner; a titled ProgressView stacks and centres the spinner over its label.
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在读取 bucket…").font(.callout).foregroundStyle(.secondary)
                }
            } else if let loadError, loadError.needsLogin {
                Text(loadError.message).font(.callout).foregroundStyle(.secondary)
                LoginForm(store: store, running: $running, output: $output)
            } else {
                if let loadError {
                    Text("\(loadError.message)。可以直接填写 bucket 名称和地域。").font(.callout).foregroundStyle(.secondary)
                }
                Picker("Bucket", selection: $choice) {
                    ForEach(buckets) { bucket in Text("\(bucket.name)（\(bucket.region)）").tag(bucket.name) }
                    Divider()
                    Text("新建私有 bucket…").tag(Self.newBucket)
                }
                if choice == Self.newBucket || (loadError != nil && buckets.isEmpty) {
                    TextField(appIdHint, text: $newName).textFieldStyle(.roundedBorder)
                    TextField("地域，例如 ap-guangzhou", text: choice == Self.newBucket ? $newRegion : $manualRegion)
                        .textFieldStyle(.roundedBorder)
                }
                TextField("目录前缀", text: $prefix).textFieldStyle(.roundedBorder)
                Text("多个项目可以共用一个 bucket，各用一个前缀。对象保存在 <前缀>/<oid 前两位>/…").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("接入") {
                        if choice == Self.newBucket { confirmingCreate = true } else { run(create: false) }
                    }
                    .disabled(running || target == nil || prefix.isEmpty)
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .task { await load() }
        .confirmationDialog("新建私有 bucket \(target?.name ?? "")？", isPresented: $confirmingCreate) {
            Button("新建并接入") { run(create: true) }
        } message: {
            Text("COS 会按存储量和下载流量计费。新建的 bucket 一律私有读写。")
        }
    }

    private var appIdHint: String {
        if let appId = buckets.first.flatMap({ $0.name.split(separator: "-").last }) { return String(localized: "bucket 名称（自动加上 -\(String(appId))）") }
        return String(localized: "bucket 名称，包含 -APPID")
    }

    /// The bucket and region the form currently points at.
    private var target: (name: String, region: String)? {
        if choice == Self.newBucket || (loadError != nil && buckets.isEmpty) {
            var name = newName.trimmingCharacters(in: .whitespaces)
            if !name.isEmpty, name.range(of: #"-\d{5,20}$"#, options: .regularExpression) == nil,
               let appId = buckets.first.flatMap({ $0.name.split(separator: "-").last }) {
                name += "-\(appId)"
            }
            let region = (choice == Self.newBucket ? newRegion : manualRegion).trimmingCharacters(in: .whitespaces)
            return name.isEmpty || region.isEmpty ? nil : (name, region)
        }
        return buckets.first { $0.name == choice }.map { ($0.name, $0.region) }
    }

    private func load() async {
        guard let repository = store.repository else { return }
        if prefix.isEmpty { prefix = "yunbox/\(repository.lastPathComponent)" }
        loading = true
        defer { loading = false }
        do {
            buckets = try await store.client().buckets(directory: repository)
            loadError = nil
            choice = buckets.first?.name ?? Self.newBucket
        } catch let error as BucketListingError {
            loadError = error
            choice = Self.newBucket
        } catch {
            loadError = BucketListingError(code: "REQUEST_FAILED", message: error.localizedDescription)
        }
    }

    private func run(create: Bool) {
        guard let repository = store.repository, let target else { return }
        running = true
        Task {
            defer { running = false }
            do {
                output = try await store.client().setUpCos(repository: repository, bucket: target.name, region: target.region, prefix: prefix, create: create)
            } catch {
                output = CommandOutput(exitCode: -1, text: error.localizedDescription)
            }
            store.checkCos()
        }
    }
}
