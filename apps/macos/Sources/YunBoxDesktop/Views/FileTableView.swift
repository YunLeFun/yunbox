import AppKit
import SwiftUI
import YunBoxKit

struct FileTableView: View {
    @Bindable var store: InspectorStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("文件明细").font(.headline)
                Text("\(store.visibleRows.count) / \(store.rows.count) 个对象 · 按大小降序")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Table(store.visibleRows, selection: $store.selectedFile) {
                TableColumn("文件") { row in
                    HStack {
                        Image(systemName: row.kind == .lfs ? "shippingbox" : "doc").foregroundStyle(.secondary)
                        Text(row.path).lineLimit(1).truncationMode(.middle).help(row.object.paths.joined(separator: "\n"))
                    }
                }.width(min: 170, ideal: 340)
                TableColumn("类型") { row in Text(row.kind.rawValue).foregroundStyle(.secondary) }.width(45)
                TableColumn("原始大小") { row in Text(byteLabel(row.object.bytes)).monospacedDigit().help("\(row.object.bytes) 字节") }.width(90)
                TableColumn("预算") { row in
                    Text(row.object.exceedsFileLimit ? "超限" : "—").foregroundStyle(row.object.exceedsFileLimit ? .orange : .secondary)
                }.width(50)
            }
            .overlay {
                if store.visibleRows.isEmpty {
                    Text(store.rows.isEmpty ? "本次范围没有新增文件内容对象" : "没有匹配的文件")
                        .foregroundStyle(.secondary).allowsHitTesting(false)
                }
            }
            .frame(minHeight: 140)
            if let row = store.selectedRow {
                GroupBox {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("\(row.kind.rawValue) · \(row.object.bytes.formatted()) 字节").font(.callout.bold())
                            Spacer()
                            Button("在 Finder 中显示") { store.reveal(row) }.disabled(!canReveal(row))
                            Button("复制路径") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(row.object.paths.joined(separator: "\n"), forType: .string)
                            }.disabled(row.object.paths.isEmpty)
                        }
                        Text(row.object.oid).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
                        ScrollView {
                            Text(row.object.paths.isEmpty ? "路径未知" : row.object.paths.joined(separator: "\n"))
                                .font(.caption).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                        }.frame(maxHeight: 60)
                    }.padding(4).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func canReveal(_ row: FileRow) -> Bool {
        guard let repository = store.repository, let path = row.object.paths.first else { return false }
        return FileManager.default.fileExists(atPath: repository.appendingPathComponent(path).path)
    }
}
