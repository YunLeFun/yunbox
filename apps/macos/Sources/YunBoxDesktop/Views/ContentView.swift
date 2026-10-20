import SwiftUI
import UniformTypeIdentifiers
import YunBoxKit

struct ContentView: View {
    @Bindable var store: InspectorStore
    @Bindable var types: AssetTypesStore

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { store.repository?.path }, set: { tag in
                // Blocked rows carry a prefixed tag, so only the recent-list row shows the selection.
                let path = tag.map { $0.hasPrefix(blockedTagPrefix) ? String($0.dropFirst(blockedTagPrefix.count)) : $0 }
                if let path, path != store.repository?.path { store.select(URL(fileURLWithPath: path)) }
            })) {
                if !store.blockedPushes.isEmpty {
                    Section("最近被拦截") {
                        ForEach(store.blockedPushes) { blocked in
                            BlockedPushRow(blocked: blocked)
                                .tag(blockedTagPrefix + blocked.path)
                                .contextMenu { Button("从列表隐藏") { store.dismissBlockedPush(blocked.path) } }
                        }
                    }
                }
                Section("最近的仓库") {
                    ForEach(Array(store.recentPaths.enumerated()), id: \.element) { index, path in
                        Label {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(URL(fileURLWithPath: path).lastPathComponent).lineLimit(1)
                                    Text(URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent)
                                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 4)
                                if index < RecentRepositories.shortcutCount {
                                    Text("⌘\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                                }
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
                    // The chip is centred on the title block and shares the report's 24-point right edge.
                    HStack(alignment: .center, spacing: 16) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(repository.lastPathComponent).font(.title2.bold())
                            HStack(spacing: 6) {
                                Text(repository.path)
                                    .lineLimit(1).truncationMode(.middle)
                                    .textSelection(.enabled)
                                if let date = store.checkedAt {
                                    Text("·")
                                    Text("检查于 \(checkedLabel(date))").fixedSize()
                                }
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        AssetTypesChip(types: types)
                        CosStatusChip(store: store)
                    }
                    .padding(.horizontal, 24).padding(.vertical, 18)
                    // Also re-reads after switching repositories; the CLI only looks at .gitattributes and the index.
                    .task(id: repository.path) { types.refresh() }
                    Divider()
                }
                if let report = store.result?.report {
                    StatusBanner(store: store)
                    ReportView(store: store, report: report)
                } else if store.isInspecting {
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
        .sheet(isPresented: $store.showingCos) { CosSheet(store: store) }
        .sheet(isPresented: $types.showing) { AssetTypesSheet(types: types) }
        .fileImporter(isPresented: $store.choosingRepository, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { store.select(url) }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let first = urls.first else { return false }
            return store.select(first)
        }
    }
}

/// Explains when the visible report is not the result of a finished, current inspection.
private struct StatusBanner: View {
    @Bindable var store: InspectorStore

    var body: some View {
        if store.isInspecting {
            banner(symbol: "arrow.triangle.2.circlepath", tint: .secondary,
                   text: store.isShowingCache ? "正在重新检查，先显示上次的结果。" : "正在重新检查…") {
                ProgressView().controlSize(.small)
                Button("取消") { store.cancel() }
            }
        } else if let error = store.error {
            banner(symbol: "exclamationmark.triangle.fill", tint: .orange, text: "重新检查未完成，显示的是上次的结果：\(error)") {
                Button("重试") { store.inspect() }
            }
        } else if store.isShowingCache {
            banner(symbol: "clock.arrow.circlepath", tint: .secondary, text: "这是上次检查的结果，仓库可能已有新的提交。") {
                Button("重新检查") { store.inspect() }
            }
        }
    }

    private func banner(symbol: String, tint: Color, text: LocalizedStringKey, @ViewBuilder actions: () -> some View) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(text).font(.callout).lineLimit(2).textSelection(.enabled)
            Spacer()
            actions()
        }
        .padding(.horizontal, 24).padding(.vertical, 8)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}

private let blockedTagPrefix = "blocked:"

/// One repository in “最近被拦截”: why and when its last push was stopped; the CLI's summary on hover.
private struct BlockedPushRow: View {
    let blocked: BlockedPush

    var body: some View {
        let url = URL(fileURLWithPath: blocked.path)
        Label {
            VStack(alignment: .leading, spacing: 3) {
                Text(url.lastPathComponent).lineLimit(1)
                Text("\(blocked.reason.title) · \(blocked.blockedAt.formatted(.relative(presentation: .named)))")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        } icon: {
            Image(systemName: blocked.reason.symbol).foregroundStyle(blocked.reason == .freeze ? Color.orange : Color.red)
        }
        .help(blocked.summary.isEmpty ? blocked.path : "\(blocked.path)\n\(blocked.summary)")
    }
}

extension BlockedPush.Reason {
    var title: String {
        switch self {
        case .freeze: String(localized: "禁推时段")
        case .exceeded: String(localized: "超出限额")
        case .cancelled: String(localized: "已取消推送")
        }
    }

    var symbol: String {
        switch self {
        case .freeze: "clock.badge.xmark"
        case .exceeded: "exclamationmark.triangle"
        case .cancelled: "xmark.circle"
        }
    }
}

private func checkedLabel(_ date: Date) -> String {
    Calendar.current.isDateInToday(date)
        ? date.formatted(date: .omitted, time: .shortened)
        : date.formatted(date: .abbreviated, time: .shortened)
}
