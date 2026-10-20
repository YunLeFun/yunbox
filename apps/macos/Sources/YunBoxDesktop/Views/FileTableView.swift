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

    private var table: some View {
        Table(store.visibleRows, selection: $store.selectedFile) {
            TableColumn("文件") { row in
                HStack {
                    Image(systemName: row.kind == .lfs ? "shippingbox" : "doc").foregroundStyle(.secondary)
                    Text(row.path).lineLimit(1).truncationMode(.middle).help(row.object.paths.joined(separator: "\n"))
                }
            }.width(min: 170, ideal: 340)
            TableColumn("变更") { row in
                Text(store.change(for: row)?.statusLabel ?? "—").foregroundStyle(.secondary)
            }.width(45)
            TableColumn("类型") { row in Text(row.kind.rawValue).foregroundStyle(.secondary) }.width(45)
            TableColumn("原始大小") { row in Text(byteLabel(row.object.bytes)).monospacedDigit().help("\(row.object.bytes) 字节") }.width(90)
            TableColumn("预算") { row in
                if row.object.onRemote == true {
                    Text("已在 COS").foregroundStyle(.secondary).help("COS 里已有这个对象，推送时跳过")
                } else {
                    Text(row.object.exceedsFileLimit ? "超限" : "—").foregroundStyle(row.object.exceedsFileLimit ? .orange : .secondary)
                }
            }.width(60)
        }
        .overlay {
            if store.visibleRows.isEmpty {
                Text(store.rows.isEmpty ? "本次范围没有新增文件内容对象" : "没有匹配的文件")
                    .foregroundStyle(.secondary).allowsHitTesting(false)
            }
        }
    }
}
