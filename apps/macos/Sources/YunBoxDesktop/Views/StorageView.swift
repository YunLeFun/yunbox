import AppKit
import SwiftUI
import YunBoxKit

/// Header chip: whether this repository pushes LFS objects straight to its own storage (COS or S3), and whether that works.
struct StorageStatusChip: View {
    @Bindable var store: InspectorStore

    var body: some View {
        Button { store.showingStorage = true } label: {
            HStack(spacing: 6) {
                if store.isCheckingStorage && store.storageReport == nil {
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
        .help("存储直连状态（腾讯云 COS 或 S3 兼容存储），点击查看检查结果和接入")
    }

    private var label: String {
        guard let report = store.storageReport else { return store.storageError == nil ? String(localized: "正在检查存储…") : String(localized: "存储状态未知") }
        switch report.mode {
        case .cos: return report.isHealthy ? String(localized: "直连 \(report.storageName) · 正常") : String(localized: "直连 \(report.storageName) · 需要处理")
        case .server: return report.isHealthy ? String(localized: "YunBox 服务端 · 正常") : String(localized: "YunBox 服务端 · 需要处理")
        case .none: return String(localized: "未接入存储")
        }
    }

    private var symbol: String {
        guard let report = store.storageReport else { return "icloud.slash" }
        if report.mode == .none { return "icloud.and.arrow.up" }
        return report.isHealthy ? "checkmark.icloud" : "exclamationmark.icloud"
    }

    private var tint: Color {
        guard let report = store.storageReport, report.mode != .none else { return .secondary }
        return report.isHealthy ? .green : .orange
    }
}

/// Doctor results, `yunbox login` and `git yunbox init` for direct COS or S3-compatible storage, without a terminal.
struct StorageSheet: View {
    @Bindable var store: InspectorStore
    @Environment(\.dismiss) private var dismiss
    @State private var output: CommandOutput?
    @State private var running = false
    @State private var copiedPrompt = false
    /// The store to connect to while the repository is not set up; the English site leads with R2.
    @State private var setupProvider: StorageProvider = AppLanguage.interfaceIsEnglish ? .s3 : .cos

    /// The repository's own store once it is in direct mode, otherwise the one being set up.
    private var provider: StorageProvider { store.storageReport?.provider ?? setupProvider }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("存储").font(.title2.bold())
                Spacer()
                if store.isCheckingStorage { ProgressView().controlSize(.small) }
                Button { copyAIPrompt() } label: {
                    Label(copiedPrompt ? "已复制" : "复制给 AI 的接入说明", systemImage: copiedPrompt ? "checkmark" : "sparkles")
                }
                .help("复制一段提示词，粘贴给 Claude Code、Codex 等编程助手，由它按步骤接入；密钥仍由你自己保存")
                Button("重新检查") { store.checkStorage() }.disabled(store.isCheckingStorage || running)
            }
            if let report = store.storageReport, report.mode == .cos, let location = report.location {
                Label(report.storageFullName + " · " + location.label, systemImage: "externaldrive.connected.to.line.below")
                    .font(.callout).textSelection(.enabled)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let error = store.storageError {
                        Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    }
                    if let report = store.storageReport {
                        StepList(steps: report.steps)
                        if report.needsLogin {
                            Divider()
                            LoginForm(store: store, provider: report.provider ?? .cos, service: report.s3Service, running: $running, output: $output)
                        } else if report.mode == .none {
                            Divider()
                            SetupForm(store: store, provider: $setupProvider, running: $running, output: $output)
                        } else if report.mode == .server {
                            Text("这个仓库使用 YunBox 服务端（lfs.url）。要改成直连 COS 或 S3 兼容存储，请在终端运行 git yunbox init --force。")
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
                Text("密钥只保存在这台电脑上（钥匙串），仓库里只记录 bucket、地域、前缀等位置信息。")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Link("接入说明", destination: (provider == .s3 ? DocsPage.r2 : .quickStart).url).font(.callout)
                Link("AI 接入说明", destination: DocsPage.ai.url).font(.callout)
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 640, height: 680)
    }
}

extension StorageSheet {
    /// Put a ready-to-paste prompt for an AI coding assistant on the clipboard.
    func copyAIPrompt() {
        guard let repository = store.repository else { return }
        let client = try? store.client()
        let prompt = AIOnboarding.prompt(repository: repository, report: store.storageReport, provider: setupProvider, node: client?.node, cli: client?.cli)
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

/// Saves the user's own keys with `yunbox login [--provider s3]`; the secret goes over stdin.
private struct LoginForm: View {
    let store: InspectorStore
    let provider: StorageProvider
    /// Which S3 service the repository uses, for the hint; `nil` for COS.
    let service: S3Service?
    @Binding var running: Bool
    @Binding var output: CommandOutput?
    @State private var secretId = ""
    @State private var secretKey = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if provider == .cos {
                Text("保存腾讯云密钥").font(.headline)
                Text("用管理员分配给你的子账号密钥（yunbox policy 可以生成它需要的最小权限策略）。")
                    .font(.callout).foregroundStyle(.secondary)
                TextField("SecretId", text: $secretId).textFieldStyle(.roundedBorder)
                SecureField("SecretKey", text: $secretKey).textFieldStyle(.roundedBorder)
            } else {
                Text("保存 S3 密钥").font(.headline)
                Group {
                    if service == .r2 {
                        Text("用管理员在 Cloudflare 控制台「管理 R2 API 令牌」里为你创建的令牌：访问密钥 ID 和机密访问密钥。令牌只需要授权这个 bucket。")
                    } else {
                        Text("用管理员在存储服务控制台为你创建的 Access Key，只授权这个 bucket。")
                    }
                }
                .font(.callout).foregroundStyle(.secondary)
                TextField("Access Key ID", text: $secretId).textFieldStyle(.roundedBorder)
                SecureField("Secret Access Key", text: $secretKey).textFieldStyle(.roundedBorder)
                Text("保存前会用这对密钥读取一次这个 bucket，确认密钥有效。").font(.caption).foregroundStyle(.secondary)
            }
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
                output = try await store.client().login(provider: provider, secretId: id, secretKey: key, directory: repository)
                if output?.succeeded == true {
                    secretKey = ""
                    store.checkStorage()
                }
            } catch {
                output = CommandOutput(exitCode: -1, text: error.localizedDescription)
            }
        }
    }
}

/// Chooses COS or S3-compatible storage for a repository that is not set up yet.
private struct SetupForm: View {
    let store: InspectorStore
    @Binding var provider: StorageProvider
    @Binding var running: Bool
    @Binding var output: CommandOutput?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("接入：把素材直传到自己的存储").font(.headline)
            Picker("存储", selection: $provider) {
                Text("腾讯云 COS").tag(StorageProvider.cos)
                Text("S3 兼容存储（R2、AWS S3、MinIO）").tag(StorageProvider.s3)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(running)
            switch provider {
            case .cos: CosSetupForm(store: store, running: $running, output: $output)
            case .s3: S3SetupForm(store: store, running: $running, output: $output)
            }
        }
    }
}

/// Runs `git yunbox init --provider s3 …` for a bucket made in the service's own console; YunBox cannot list or
/// create S3 buckets. Keys typed here are saved first with `yunbox login --provider s3`.
private struct S3SetupForm: View {
    let store: InspectorStore
    @Binding var running: Bool
    @Binding var output: CommandOutput?
    @State private var setup = S3Setup()
    @State private var accessKeyID = ""
    @State private var secretAccessKey = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("云匣不能列出或新建 S3 兼容存储的 bucket：请先在服务自己的控制台建好私有 bucket，再填写在这里。")
                .font(.callout).foregroundStyle(.secondary)
            Picker("服务", selection: $setup.service) {
                ForEach(S3Service.allCases) { service in
                    Text(service == .custom ? String(localized: "其他（自定义 endpoint）") : service.name).tag(service)
                }
            }
            switch setup.service {
            case .r2:
                TextField("Cloudflare 账户 ID（R2 概览页右侧的 Account ID）", text: $setup.accountID).textFieldStyle(.roundedBorder)
            case .aws:
                TextField("地域（默认 us-east-1）", text: $setup.region).textFieldStyle(.roundedBorder)
            case .minio, .custom:
                TextField("服务地址（不含 bucket），例如 https://minio.example.com", text: $setup.endpoint).textFieldStyle(.roundedBorder)
                TextField("地域（默认 us-east-1）", text: $setup.region).textFieldStyle(.roundedBorder)
            }
            TextField("Bucket", text: $setup.bucket).textFieldStyle(.roundedBorder)
            TextField("目录前缀", text: $setup.prefix).textFieldStyle(.roundedBorder)
            if setup.service == .r2 {
                Label("R2 的 API token 只能限定到 bucket，不能限定到前缀：能访问这个 bucket 的 token 可以读写其中所有前缀。建议每个项目一个 bucket，给协作者的 token 只授权这个 bucket。", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            } else {
                Text("对象保存在 <前缀>/<oid 前两位>/…；密钥的权限只需要这个 bucket（AWS 可以用 IAM 策略限定到前缀）。").font(.caption).foregroundStyle(.secondary)
            }
            Text("密钥").font(.subheadline.weight(.medium)).padding(.top, 4)
            TextField("Access Key ID", text: $accessKeyID).textFieldStyle(.roundedBorder)
            SecureField("Secret Access Key", text: $secretAccessKey).textFieldStyle(.roundedBorder)
            Text("这台电脑已经保存过 S3 密钥（yunbox login --provider s3）时可以留空。填写后先存进钥匙串，接入时再用它检查能否读写这个 bucket。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                if let problem = setup.problem, edited {
                    Text(problem).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("接入") { run() }
                    .disabled(running || setup.problem != nil || accessKeyID.isEmpty != secretAccessKey.isEmpty)
                    .buttonStyle(.borderedProminent)
            }
        }
        .task {
            if setup.prefix.isEmpty, let repository = store.repository { setup.prefix = "yunbox/\(repository.lastPathComponent)" }
        }
    }

    /// Only nag about the form once the user has started filling it in.
    private var edited: Bool { !(setup.accountID + setup.endpoint + setup.bucket).isEmpty }

    private func run() {
        guard let repository = store.repository else { return }
        running = true
        let id = accessKeyID.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = secretAccessKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let setup = setup
        Task {
            defer { running = false }
            do {
                let client = try store.client()
                var saved = ""
                if !id.isEmpty {
                    let login = try await client.login(provider: .s3, secretId: id, secretKey: key, directory: repository)
                    guard login.succeeded else {
                        output = login
                        return
                    }
                    secretAccessKey = ""
                    saved = login.text.trimmingCharacters(in: .newlines) + "\n"
                }
                let result = try await client.setUpS3(repository: repository, setup: setup)
                output = CommandOutput(exitCode: result.exitCode, text: saved + result.text)
            } catch {
                output = CommandOutput(exitCode: -1, text: error.localizedDescription)
            }
            store.checkStorage()
        }
    }
}

/// Picks or creates a bucket and runs `git yunbox init` for direct COS.
private struct CosSetupForm: View {
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
            if loading {
                // Inline like the header's spinner; a titled ProgressView stacks and centres the spinner over its label.
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在读取 bucket…").font(.callout).foregroundStyle(.secondary)
                }
            } else if let loadError, loadError.needsLogin {
                Text(loadError.message).font(.callout).foregroundStyle(.secondary)
                LoginForm(store: store, provider: .cos, service: nil, running: $running, output: $output)
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
            store.checkStorage()
        }
    }
}
