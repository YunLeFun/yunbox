import AppKit
import QuickLook
import SwiftUI
import YunBoxKit

/// The selected file's change: before/after images, a text diff, or sizes and Quick Look.
/// Versions come from Git or the LFS store by content ID, never from the worktree.
struct ChangeDetailView: View {
    @Bindable var store: InspectorStore
    let row: FileRow

    @State private var preview: LoadedPreview?
    @State private var failure: String?
    @State private var quickLook: URL?

    private var change: InspectionReport.Change? { store.change(for: row) }
    private var path: String { change?.path ?? row.object.paths.first ?? row.path }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                header
                Divider()
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
            }.padding(4)
        }
        .task(id: "\(store.repository?.path ?? ""):\(row.id)") { await load() }
        .quickLookPreview($quickLook, in: preview?.files ?? [])
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if let change { StatusBadge(change: change) }
                Text(path).font(.callout.bold()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                    .help(row.object.paths.joined(separator: "\n"))
                Text(row.kind.rawValue).font(.caption).foregroundStyle(.secondary)
                    .padding(.horizontal, 5).overlay(RoundedRectangle(cornerRadius: 4).stroke(.quaternary))
                Spacer(minLength: 8)
                Button("快速查看") { quickLook = preview?.files.last }
                    .disabled(preview == nil)
                    .help(preview?.before == nil ? "用「快速查看」打开推送的版本" : "用「快速查看」打开推送前后两个版本，左右方向键切换")
                Button("在 Finder 中显示") { store.reveal(row) }.disabled(!canReveal)
                Button("复制路径") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(row.object.paths.joined(separator: "\n"), forType: .string)
                }.disabled(row.object.paths.isEmpty)
            }
            HStack(spacing: 6) {
                Text(sizeSummary).monospacedDigit()
                Text("·")
                Text(row.object.oid).font(.system(.caption, design: .monospaced)).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
            }.font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var content: some View {
        if let failure {
            Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
        } else if let preview {
            switch preview.body {
            case .image(let before, let after):
                ImageComparison(before: before, after: after, beforeNote: preview.beforeNote)
            case .diff(let text):
                DiffView(text: text, note: preview.beforeNote)
            case .other:
                OtherPreview(file: preview.after, note: preview.beforeNote) { quickLook = preview.files.last }
            }
        } else {
            ProgressView().controlSize(.small)
        }
    }

    private var sizeSummary: String {
        guard let change else { return "\(byteLabel(row.object.bytes)) · \(row.object.bytes.formatted()) 字节" }
        let side = { (bytes: Int64?, absent: Bool) in absent ? "无" : bytes.map(byteLabel) ?? "未知" }
        var text = "\(side(change.beforeBytes, change.status == "added" || change.status == "transient")) → \(side(change.afterBytes, change.status == "deleted" || change.status == "transient"))"
        if let before = change.beforeBytes, let after = change.afterBytes, before != after {
            text += "（\(after > before ? "+" : "−")\(byteLabel(abs(after - before)))）"
        }
        if change.versions > 1 { text += " · 本次上传 \(change.versions) 个版本" }
        return text
    }

    private var canReveal: Bool {
        guard let repository = store.repository, let path = row.object.paths.first else { return false }
        return FileManager.default.fileExists(atPath: repository.appendingPathComponent(path).path)
    }

    /// Export the pushed version (this row) and, for a modification, the version before the push.
    private func load() async {
        preview = nil
        failure = nil
        guard let reader = store.contentReader() else { return }
        let path = path
        let modified = change?.status == "modified"
        let beforeOid = modified ? change?.beforeOid : nil
        do {
            let after = try store.previewFile(oid: row.object.oid, name: ContentReader.fileName(for: path, tag: modified ? "推送后" : nil))
            try await reader.export(oid: row.object.oid, to: after)
            var before: URL?
            var beforeNote: String?
            if let beforeOid {
                let file = try store.previewFile(oid: beforeOid, name: ContentReader.fileName(for: path, tag: "推送前"))
                do {
                    try await reader.export(oid: beforeOid, to: file)
                    before = file
                } catch is CancellationError {
                    return
                } catch {
                    beforeNote = "推送前的版本不在本地（LFS 旧版本可能尚未下载），只能显示推送后的版本。"
                }
            } else if modified {
                beforeNote = "推送前的版本不在本地，只能显示推送后的版本。"
            }
            let body: LoadedPreview.Body
            switch ContentReader.kind(of: after, path: path) {
            case .image:
                if let image = NSImage(contentsOf: after) {
                    body = .image(before: before.flatMap(NSImage.init(contentsOf:)), after: image)
                } else {
                    body = .other
                }
            case .text:
                body = try await reader.diff(before: before, after: after).map(LoadedPreview.Body.diff) ?? .other
            case .other:
                body = .other
            }
            try Task.checkCancellation()
            preview = LoadedPreview(before: before, after: after, beforeNote: beforeNote, body: body)
        } catch is CancellationError {
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? "无法读取这个版本。"
        }
    }
}

private struct LoadedPreview {
    enum Body {
        case image(before: NSImage?, after: NSImage)
        case diff(String)
        case other
    }

    let before: URL?
    let after: URL
    let beforeNote: String?
    let body: Body
    /// Quick Look items: before first, so the left arrow steps back in time.
    var files: [URL] { [before, after].compactMap { $0 } }
}

private struct StatusBadge: View {
    let change: InspectionReport.Change

    var body: some View {
        let tint: Color = switch change.status {
        case "added": .green
        case "modified": .blue
        case "deleted": .red
        default: .purple
        }
        Text(change.statusLabel).font(.caption.bold()).foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
    }
}

enum ImageCompareMode: String, CaseIterable, Identifiable {
    case sideBySide = "并排"
    case slider = "滑块"
    case toggle = "切换"
    var id: String { rawValue }
}

/// Before and after side by side, overlaid with a draggable divider, or one at a time.
private struct ImageComparison: View {
    let before: NSImage?
    let after: NSImage
    let beforeNote: String?
    @AppStorage("imageCompareMode") private var mode = ImageCompareMode.sideBySide
    @State private var split = 0.5
    @State private var showingBefore = false

    var body: some View {
        if let before {
            VStack(spacing: 8) {
                HStack {
                    Picker("对比方式", selection: $mode) {
                        ForEach(ImageCompareMode.allCases) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented).labelsHidden().fixedSize()
                    if mode == .toggle {
                        Picker("版本", selection: $showingBefore) {
                            Text("推送前").tag(true)
                            Text("推送后").tag(false)
                        }.pickerStyle(.segmented).labelsHidden().fixedSize()
                    }
                    Spacer()
                    if mode == .slider { Text("拖动分隔线对比").font(.caption).foregroundStyle(.secondary) }
                }
                switch mode {
                case .sideBySide:
                    HStack(spacing: 8) {
                        ImagePane(image: before, label: "推送前")
                        ImagePane(image: after, label: "推送后")
                    }
                case .slider:
                    slider(before: before)
                case .toggle:
                    ImagePane(image: showingBefore ? before : after, label: showingBefore ? "推送前" : "推送后")
                        .onTapGesture { showingBefore.toggle() }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if let beforeNote { Label(beforeNote, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary) }
                ImagePane(image: after, label: "推送后")
            }
        }
    }

    private func slider(before: NSImage) -> some View {
        GeometryReader { geometry in
            let x = geometry.size.width * split
            ZStack {
                Image(nsImage: after).resizable().scaledToFit()
                // Mask in the container's coordinates, so the divider and the cut line up.
                Image(nsImage: before).resizable().scaledToFit()
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .mask(alignment: .leading) { Rectangle().frame(width: x) }
                Rectangle().fill(.white).frame(width: 2).shadow(radius: 2).position(x: x, y: geometry.size.height / 2)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .overlay(alignment: .topLeading) { Caption(text: "推送前 · \(pixels(before))").padding(6) }
            .overlay(alignment: .topTrailing) { Caption(text: "推送后 · \(pixels(after))").padding(6) }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { split = min(max($0.location.x / geometry.size.width, 0), 1) })
            .onHover { inside in if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
        }
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
    }
}

private struct ImagePane: View {
    let image: NSImage
    let label: String

    var body: some View {
        Image(nsImage: image).resizable().scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(4)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
            .overlay(alignment: .topLeading) { Caption(text: "\(label) · \(pixels(image))").padding(6) }
    }
}

private struct Caption: View {
    let text: String
    var body: some View {
        Text(text).font(.caption.monospacedDigit()).padding(.horizontal, 6).padding(.vertical, 2)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 4))
    }
}

/// Pixel size, which is what changes when an asset is re-exported; points can hide it.
private func pixels(_ image: NSImage) -> String {
    guard let representation = image.representations.first, representation.pixelsWide > 0 else {
        return "\(Int(image.size.width))×\(Int(image.size.height))"
    }
    return "\(representation.pixelsWide)×\(representation.pixelsHigh)"
}

/// `git diff` of the two versions, coloured by line type.
private struct DiffView: View {
    let text: String
    let note: String?
    private static let lineLimit = 5000

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        VStack(alignment: .leading, spacing: 6) {
            if let note { Label(note, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary) }
            if text.isEmpty {
                Text("两个版本的内容相同。").foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.prefix(Self.lineLimit).enumerated()), id: \.offset) { _, line in
                            DiffLine(line: line)
                        }
                        if lines.count > Self.lineLimit {
                            Text("差异过长，只显示前 \(Self.lineLimit) 行；可用「快速查看」打开完整文件。")
                                .font(.caption).foregroundStyle(.secondary).padding(6)
                        }
                    }.textSelection(.enabled)
                }
                .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

private struct DiffLine: View {
    let line: Substring

    var body: some View {
        let (foreground, background): (Color, Color) = switch line.first {
        case "+": (.primary, .green.opacity(0.16))
        case "-": (.primary, .red.opacity(0.16))
        case "@": (.blue, .blue.opacity(0.07))
        case "\\": (.secondary, .clear)
        default: (.primary, .clear)
        }
        Text(line.isEmpty ? " " : String(line))
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(background)
    }
}

/// Files without an inline preview: the file icon and Quick Look.
private struct OtherPreview: View {
    let file: URL
    let note: String?
    let quickLook: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: file.path)).resizable().frame(width: 64, height: 64)
            Text("这种文件没有内嵌预览，可以用「快速查看」打开。").foregroundStyle(.secondary)
            if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
            Button("快速查看", action: quickLook)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
