import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @Bindable var store: InspectorStore

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { store.repository?.path }, set: { path in
                if let path, path != store.repository?.path { store.select(URL(fileURLWithPath: path)) }
            })) {
                Section("最近的仓库") {
                    ForEach(store.recentPaths, id: \.self) { path in
                        Label {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(URL(fileURLWithPath: path).lastPathComponent).lineLimit(1)
                                Text(URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent)
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        } icon: { Image(systemName: "folder") }
                        .tag(path)
                        .help(path)
                        .contextMenu { Button("从最近列表移除") { store.forget(path) } }
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationTitle("云匣")
            .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 280)
            .safeAreaInset(edge: .bottom) {
                HStack {
                    Image(systemName: "shippingbox")
                    Text("YunBox").fontWeight(.medium)
                    Spacer()
                    SettingsLink { Image(systemName: "gearshape") }.buttonStyle(.plain).help("设置")
                }.font(.callout).foregroundStyle(.secondary).padding()
            }
        } detail: {
            VStack(spacing: 0) {
                if let repository = store.repository {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(repository.lastPathComponent).font(.title2.bold())
                            Text(repository.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        Spacer()
                        if let date = store.checkedAt {
                            Text("检查于 \(date.formatted(date: .omitted, time: .shortened))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(24)
                    Divider()
                }
                if store.isInspecting {
                    VStack(spacing: 18) {
                        ProgressView().controlSize(.large)
                        Text("正在分析已提交的历史…").foregroundStyle(.secondary)
                        Button("取消") { store.cancel() }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = store.error {
                    ContentUnavailableView {
                        Label("检查未完成", systemImage: "exclamationmark.triangle")
                    } description: { Text(error).textSelection(.enabled) } actions: {
                        Button("重试") { store.inspect() }
                        SettingsLink { Text("打开设置") }
                    }
                } else if let report = store.result?.report {
                    ReportView(store: store, report: report)
                } else {
                    ContentUnavailableView {
                        Label("检查推送体积", systemImage: "shippingbox")
                    } description: {
                        Text("选择 Git 仓库，查看 Git 与 LFS 用量、超限文件和完整报告。\n也可以把仓库文件夹拖到窗口中。")
                    } actions: {
                        Button("选择仓库…") { store.choosingRepository = true }.buttonStyle(.borderedProminent)
                        if store.repository != nil { Button("检查当前仓库") { store.inspect() } }
                    }
                }
            }
            .navigationTitle("推送检查")
            .toolbar {
                ToolbarItemGroup {
                    Button { store.choosingRepository = true } label: { Label("选择仓库", systemImage: "folder.badge.plus") }
                    Button { store.copyJSON() } label: { Label(store.copiedJSON ? "已复制 JSON" : "复制 JSON", systemImage: store.copiedJSON ? "checkmark" : "doc.on.doc") }.disabled(store.result == nil)
                    Button { store.inspect() } label: { Label("检查", systemImage: "arrow.clockwise") }.disabled(store.isInspecting)
                }
            }
        }
        .fileImporter(isPresented: $store.choosingRepository, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { store.select(url) }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let first = urls.first else { return false }
            return store.select(first)
        }
    }
}
