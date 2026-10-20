import SwiftUI
import UniformTypeIdentifiers
import YunBoxKit

struct SettingsView: View {
    @AppStorage("overrideLimits") private var overrideLimits = false
    @AppStorage("gitLimit") private var gitLimit = "900k"
    @AppStorage("lfsLimit") private var lfsLimit = "100m"
    @AppStorage("fileLimit") private var fileLimit = "10m"
    @AppStorage("nodePath") private var nodePath = ""
    @AppStorage("showMenuBarExtra") private var showMenuBarExtra = true
    @State private var choosingNode = false

    var body: some View {
        Form {
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
        .frame(width: 540, height: 500)
        .fileImporter(isPresented: $choosingNode, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { nodePath = url.path }
        }
    }

    private var runtimeDescription: String {
        if let client = try? InspectionClient.bundled(nodeOverride: nodePath) { return "当前：\(client.node.path)" }
        return "未找到可用的 Node.js。请选择已安装的 node 可执行文件。"
    }
}
