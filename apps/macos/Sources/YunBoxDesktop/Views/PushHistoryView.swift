import AppKit
import SwiftUI
import YunBoxKit

/// Project-scoped local decision history, with explicit, limited cleanup actions.
struct PushHistoryView: View {
    @Bindable var history: PushHistoryStore
    let inspector: InspectorStore
    @State private var confirmingClear = false
    @State private var clearAll = false
    @State private var clearProject: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("项目", selection: $history.selectedProject) {
                    Text("全部项目").tag(String?.none)
                    ForEach(history.projects(current: inspector.repository?.path), id: \.self) { path in
                        Text(verbatim: projectLabel(path)).tag(Optional(path))
                    }
                }.frame(maxWidth: 430)
                Spacer()
                Button("刷新", systemImage: "arrow.clockwise") { Task { await history.refresh(inspector: inspector) } }
                    .disabled(history.busy)
                Menu {
                    Button("清理当前项目历史…", role: .destructive) { askToClear(all: false) }
                        .disabled(history.selectedProject == nil || history.entries.isEmpty)
                    Button("清理全部历史…", role: .destructive) { askToClear(all: true) }
                } label: { Label("清理历史", systemImage: "trash") }
                .disabled(history.busy)
            }.padding()
            Divider()
            if let error = history.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).textSelection(.enabled).padding()
            }
            if history.entries.isEmpty {
                ContentUnavailableView("暂无推送保护历史", systemImage: "clock.arrow.circlepath",
                                       description: Text("钩子阻止、取消或确认继续推送后，记录会显示在这里。"))
            } else {
                Table(history.entries) {
                    TableColumn("时间") { entry in
                        Text(entry.at, format: .dateTime.year().month().day().hour().minute().second())
                            .monospacedDigit().help(entry.at.formatted(date: .complete, time: .complete))
                    }.width(min: 160, ideal: 180, max: 210)
                    TableColumn("项目") { entry in
                        Text(URL(fileURLWithPath: entry.root).lastPathComponent).help(entry.root)
                    }.width(min: 90, ideal: 130, max: 180)
                    TableColumn("原因") { entry in Text(entry.reason.title) }.width(85)
                    TableColumn("处理结果") { entry in
                        Label(entry.outcome.title, systemImage: entry.outcome.symbol)
                            .foregroundStyle(entry.outcome == .continued ? Color.blue : Color.orange)
                            .help(entry.outcome.title)
                    }.width(185)
                    TableColumn("说明") { entry in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(entry.summary).lineLimit(2)
                            if let note = entry.note, !note.isEmpty {
                                Text("用户说明：\(note)").foregroundStyle(.secondary).lineLimit(2)
                            }
                        }.textSelection(.enabled)
                            .help([entry.summary, entry.note].compactMap { $0 }.joined(separator: "\n"))
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 4) {
                Text("记录仅保存在本机，保留最近 90 天，每个项目最多 200 条，全部最多 5000 条。")
                Text("“已确认继续”表示推送检查已放行，实际上传结果请查看 Git 输出。")
                if let file = history.report?.file {
                    Text(verbatim: file).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                }
            }.font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding()
        }
        .frame(minWidth: 850, minHeight: 440)
        .overlay { if history.busy { ProgressView().controlSize(.large) } }
        .task { await history.refresh(inspector: inspector) }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await history.refresh(inspector: inspector) }
        }
        .confirmationDialog(clearAll ? String(localized: "清理全部本机推送历史？") : String(localized: "清理当前项目的推送历史？"), isPresented: $confirmingClear) {
            Button("清理历史", role: .destructive) {
                Task { await history.clear(inspector: inspector, project: clearAll ? nil : clearProject) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("清理后无法恢复历史记录。推送保护、Git 配置、素材和密钥不会被修改。")
        }
    }

    private func askToClear(all: Bool) {
        clearAll = all
        clearProject = history.selectedProject
        confirmingClear = true
    }

    private func projectLabel(_ path: String) -> String {
        let url = URL(fileURLWithPath: path)
        return url.lastPathComponent + " — " + url.deletingLastPathComponent().path
    }
}

private extension PushHistoryEntry.Reason {
    var title: String {
        switch self {
        case .freeze: String(localized: "禁推时段")
        case .exceeded: String(localized: "超出限额")
        }
    }
}

private extension PushHistoryEntry.Outcome {
    var title: String {
        switch self {
        case .blocked: String(localized: "已阻止")
        case .cancelled: String(localized: "用户取消")
        case .continued: String(localized: "已确认继续")
        }
    }
    var symbol: String {
        switch self {
        case .blocked: "hand.raised"
        case .cancelled: "xmark.circle"
        case .continued: "checkmark.circle"
        }
    }
}
