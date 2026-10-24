import SwiftUI
import YunBoxKit

struct FileTableView: View {
    @Bindable var store: InspectorStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("文件明细").font(.headline)
                Group {
                    if store.rows.isEmpty {
                        Text("\(store.visibleRows.count) / \(store.rows.count) 个对象 · 按大小降序")
                    } else {
                        Text("\(store.visibleRows.count) / \(store.rows.count) 个对象 · 按大小降序 · 选中文件查看推送前后的变化")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            VSplitView {
                table.frame(minHeight: 110)
                if let row = store.selectedRow {
                    ChangeDetailView(store: store, row: row).frame(minHeight: 260, maxHeight: .infinity)
                }
            }
        }
    }

    private var storageName: String { store.result?.report.lfs.remoteStorageName ?? "COS" }

    private var table: some View {
        Table(store.visibleRows, selection: $store.selectedFile) {
            TableColumn("文件") { row in
                FilePathCell(row: row)
            }.width(min: 170, ideal: 340)
            TableColumn("变更") { row in
                FileChangeCell(change: store.change(for: row))
            }.width(min: 80, ideal: 85, max: 95)
            TableColumn("类型") { row in Text(row.kind.rawValue).foregroundStyle(.secondary) }.width(45)
            TableColumn("原始大小") { row in
                Text(byteLabel(row.object.bytes)).monospacedDigit()
                    .fontWeight(row.object.exceedsFileLimit ? .semibold : .regular)
                    .foregroundStyle(row.object.exceedsFileLimit ? AnyShapeStyle(FileTableTint(tint: .orange)) : AnyShapeStyle(.primary))
                    .help("\(row.object.bytes) 字节")
            }.width(90)
            TableColumn("预算") { row in
                if row.object.onRemote == true {
                    Text("已在 \(storageName)").foregroundStyle(.secondary).help("\(storageName) 里已有这个对象，推送时跳过")
                } else if row.object.exceedsFileLimit {
                    Label("超限", systemImage: "exclamationmark.triangle.fill")
                        .fontWeight(.medium)
                        .foregroundStyle(FileTableTint(tint: .orange))
                        .help(store.result.map { String(localized: "超过单文件预算 \(byteLabel($0.report.limits.fileBytes))") } ?? String(localized: "超限"))
                } else {
                    Text("—").foregroundStyle(.secondary)
                }
            }.width(min: 100, ideal: 105, max: 125)
        }
        .overlay {
            if store.visibleRows.isEmpty {
                Text(store.rows.isEmpty ? "本次范围没有新增文件内容对象" : "没有匹配的文件")
                    .foregroundStyle(.secondary).allowsHitTesting(false)
            }
        }
    }
}
