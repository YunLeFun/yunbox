import SwiftUI
import UniformTypeIdentifiers
import YunBoxKit

/// Resolve inside the table cell so focused selections use the system's contrasting foreground.
struct FileTableTint: ShapeStyle {
    let tint: Color

    func resolve(in environment: EnvironmentValues) -> some ShapeStyle {
        if environment.backgroundProminence == .increased { return AnyShapeStyle(.primary) }
        // Small colored labels need more contrast on the light table's white and striped rows.
        return AnyShapeStyle(environment.colorScheme == .light ? tint.mix(with: .primary, by: 0.3) : tint)
    }
}

struct FilePathCell: View {
    let row: FileRow

    var body: some View {
        let path = row.path
        let split = path.lastIndex(of: "/").map { path.index(after: $0) } ?? path.startIndex
        HStack(spacing: 7) {
            Image(systemName: symbol).foregroundStyle(.secondary)
                .frame(width: 16).accessibilityHidden(true)
            HStack(spacing: 0) {
                if split != path.startIndex {
                    Text(String(path[..<split])).foregroundStyle(.secondary)
                        .truncationMode(.middle)
                }
                Text(String(path[split...])).fontWeight(.medium)
                    .truncationMode(.middle).layoutPriority(1)
            }.lineLimit(1)
        }
        .help(row.object.paths.isEmpty ? path : row.object.paths.joined(separator: "\n"))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: path))
    }

    /// Extension-only lookup: inspecting history must not read or download files from the worktree.
    private var symbol: String {
        let ext = ((row.object.paths.first ?? "") as NSString).pathExtension.lowercased()
        // Asset formats that macOS may not register without a specialist application installed.
        switch ext {
        case "psd", "psb", "ai", "kra", "xcf", "spp", "sbsar": return "paintpalette"
        case "fbx", "obj", "blend", "max", "ma", "mb", "3ds", "dae", "gltf", "glb", "usd", "usdc", "usdz", "abc", "c4d": return "cube"
        case "tga", "exr", "hdr", "dds", "ktx", "ktx2", "astc": return "photo"
        case "ogg", "flac", "bank", "bnk", "wem": return "waveform"
        case "mkv", "webm": return "film"
        case "ttf", "otf", "woff", "woff2": return "textformat"
        case "zip", "7z", "rar", "tar", "gz", "bz2", "xz": return "doc.zipper"
        default: break
        }
        guard let type = UTType(filenameExtension: ext) else { return "doc" }
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .audio) { return "waveform" }
        if type.conforms(to: .movie) { return "film" }
        if type.conforms(to: .threeDContent) { return "cube" }
        if type.conforms(to: .font) { return "textformat" }
        if type.conforms(to: .archive) { return "doc.zipper" }
        if type.conforms(to: .sourceCode) { return "curlybraces" }
        if type.conforms(to: .text) { return "doc.text" }
        return "doc"
    }
}

struct FileChangeCell: View {
    let change: InspectionReport.Change?

    var body: some View {
        if let change {
            let style = FileChangeStyle(change.status)
            HStack(spacing: 4) {
                Image(systemName: style.symbol).font(.caption.weight(.semibold))
                    .frame(width: 12).accessibilityHidden(true)
                Text(change.statusLabel).fontWeight(.medium)
            }
            .foregroundStyle(FileTableTint(tint: style.tint))
            .lineLimit(1)
            .help(change.statusLabel)
        } else {
            Text("—").foregroundStyle(.secondary)
        }
    }
}

/// Keep the table and the selected file's detail badge consistent, including older CLI reports.
struct FileChangeStyle {
    let symbol: String
    let tint: Color

    init(_ status: String) {
        switch status {
        case "added": (symbol, tint) = ("plus", .green)
        case "modified": (symbol, tint) = ("pencil", .blue)
        case "deleted": (symbol, tint) = ("minus", .red)
        case "transient": (symbol, tint) = ("clock.arrow.circlepath", .purple)
        default: (symbol, tint) = ("questionmark", .secondary)
        }
    }
}
