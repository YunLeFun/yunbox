import SwiftUI
import YunBoxKit

struct ReportView: View {
    @Bindable var store: InspectorStore
    let report: InspectionReport
    @State private var summaryHeight: CGFloat = 300
    @State private var footerHeight: CGFloat = 30

    /// The file list and its detail pane fill the window below the summary; on a short window
    /// the report scrolls instead of squeezing them.
    var body: some View {
        GeometryReader { viewport in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    summary.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { summaryHeight = $0 }
                    FileTableView(store: store)
                        .frame(height: max(400, viewport.size.height - summaryHeight - footerHeight - 48 - 32))
                    footer.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }
                }.padding(24)
            }
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label(report.status == "exceeded" ? "超过预算" : "预算内", systemImage: report.status == "exceeded" ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                    .font(.headline).foregroundStyle(report.status == "exceeded" ? .orange : .green)
                Spacer()
                Text("单文件预算 \(byteLabel(report.limits.fileBytes))").font(.callout).foregroundStyle(.secondary)
                SettingsLink { Text("预算设置") }
            }
            HStack(spacing: 12) {
                BudgetCard(title: "Git pack", symbol: "arrow.up.doc", value: report.git.packBytes, limit: report.limits.gitBytes,
                           exceeded: report.git.exceedsLimit, display: report.git.packComplete ? byteLabel(report.git.packBytes) : "> \(byteLabel(report.git.packCapBytes))",
                           footnote: "压缩后的预计上传量")
                if let upload = report.lfs.uploadBytes {
                    BudgetCard(title: "LFS 需上传", symbol: "shippingbox", value: upload, limit: report.limits.lfsBytes,
                               exceeded: report.lfs.exceedsLimit, display: byteLabel(upload),
                               footnote: "\(report.lfs.candidateCount - report.lfs.remoteCount) 个素材对象，\(report.lfs.remoteCount) 个已在 \(report.lfs.remoteStorageName)")
                } else {
                    BudgetCard(title: "LFS 候选", symbol: "shippingbox", value: report.lfs.candidateBytes, limit: report.limits.lfsBytes,
                               exceeded: report.lfs.exceedsLimit, display: byteLabel(report.lfs.candidateBytes),
                               footnote: "\(report.lfs.candidateCount) 个素材对象")
                }
            }
            if report.lfs.remoteChecked {
                Text("已查询 \(report.lfs.remoteStorageName)：已有的 LFS 对象推送时跳过，不计入上传量。")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("LFS 尚未查询远端，实际上传量未知；远端已有对象可能跳过。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Picker("文件类型", selection: $store.kind) {
                    Text("全部").tag("全部")
                    Text("Git").tag("Git")
                    Text("LFS").tag("LFS")
                }.pickerStyle(.segmented).frame(width: 200)
                Toggle("仅超限", isOn: $store.onlyExceeded).toggleStyle(.checkbox)
                Spacer()
                TextField("搜索路径或对象 ID", text: $store.query).textFieldStyle(.roundedBorder).frame(maxWidth: 240)
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !report.warnings.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(report.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Text("已提交内容 · 同内容去重，历史版本分别统计 · 文件原始大小不等于压缩上传量")
                .font(.caption2).foregroundStyle(.tertiary)
        }
    }
}

private struct BudgetCard: View {
    let title: LocalizedStringKey
    let symbol: String
    let value: Int64
    let limit: Int64
    let exceeded: Bool
    let display: String
    let footnote: LocalizedStringKey

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 9) {
                Label(title, systemImage: symbol).font(.callout).foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline) {
                    Text(display).font(.system(size: 27, weight: .semibold, design: .rounded)).monospacedDigit()
                    Spacer()
                    if exceeded { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange) }
                }
                ProgressView(value: min(Double(value) / Double(max(limit, 1)), 1)).tint(exceeded ? .orange : .accentColor)
                HStack {
                    Text(footnote)
                    Spacer()
                    Text("预算 \(byteLabel(limit))")
                }.font(.caption).foregroundStyle(.secondary)
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
