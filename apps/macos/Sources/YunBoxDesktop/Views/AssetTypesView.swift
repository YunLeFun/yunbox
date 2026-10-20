import SwiftUI
import YunBoxKit

/// Header chip: how many asset types go through LFS, and whether assets were committed as ordinary files.
struct AssetTypesChip: View {
    @Bindable var types: AssetTypesStore

    var body: some View {
        Button { types.showing = true } label: {
            HStack(spacing: 6) {
                if types.isLoading && types.report == nil {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: symbol).foregroundStyle(tint)
                }
                label.lineLimit(1)
            }
            .font(.callout)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(.quaternary, in: Capsule())
        }
        .buttonStyle(.plain)
        .help("按素材类型查看和调整 LFS 规则")
    }

    @ViewBuilder private var label: some View {
        if let report = types.report {
            if report.plainFiles.isEmpty {
                Text("素材类型 · \(report.categories.filter { $0.state == .lfs }.count)/\(report.categories.count) 走 LFS")
            } else {
                Text("素材类型 · \(report.plainFiles.count) 个未走 LFS")
            }
        } else {
            Text(types.error == nil ? "正在读取素材类型…" : "素材类型")
        }
    }

    private var symbol: String {
        guard let report = types.report else { return types.error == nil ? "square.stack.3d.up" : "exclamationmark.triangle" }
        return report.plainFiles.isEmpty ? "square.stack.3d.up.fill" : "exclamationmark.triangle.fill"
    }

    private var tint: Color {
        guard let report = types.report else { return types.error == nil ? .secondary : .orange }
        return report.plainFiles.isEmpty ? .accentColor : .orange
    }
}

/// `git yunbox types` without a terminal: every type's LFS state, presets, and assets committed outside LFS.
struct AssetTypesSheet: View {
    @Bindable var types: AssetTypesStore
    @Environment(\.dismiss) private var dismiss
    @State private var expanded: Set<String> = []
    @State private var pending: PendingAction?
    @State private var revealOutput = false
    private static let outputID = "output"

    enum PendingAction: Identifiable {
        case remove(AssetTypesReport.Category)
        case renormalize(AssetTypesReport.Category, files: Int)
        var id: String {
            switch self {
            case .remove(let category): "remove-\(category.id)"
            case .renormalize(let category, _): "renormalize-\(category.id)"
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("素材类型").font(.title2.bold())
                Spacer()
                if types.isLoading || types.isApplying { ProgressView().controlSize(.small) }
                Button("重新读取") { types.refresh() }.disabled(types.isLoading || types.isApplying)
            }
            Text("按仓库根目录的规则判断每种素材是否走 LFS；文件数是已加入 Git 的文件。这里只增删 YunBox 生成的 .gitattributes 规则，不会提交。")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let error = types.error {
                            Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).textSelection(.enabled)
                        }
                        if let report = types.report {
                            presets(report)
                            categories(report)
                            if !report.plainFiles.isEmpty { plainFiles(report) }
                        }
                        if let output = types.output {
                            Divider()
                            CommandOutputView(output: output).id(Self.outputID)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .sheetScrollMargins()
                // What the command printed sits below everything else: bring it into view, and again once the
                // re-read report has changed the content above it.
                .onChange(of: types.output?.text) { _, text in
                    revealOutput = text != nil
                    if revealOutput { withAnimation { scroll.scrollTo(Self.outputID, anchor: .bottom) } }
                }
                .onChange(of: types.isLoading) { _, loading in
                    guard !loading, revealOutput else { return }
                    revealOutput = false
                    withAnimation { scroll.scrollTo(Self.outputID, anchor: .bottom) }
                }
            }
            HStack {
                Text("改动写入 .gitattributes（改用 LFS 时还有暂存区），确认后自己提交。")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Link("素材类型说明", destination: DocsPage.assetTypes.url).font(.callout)
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 720, height: 720)
        .task { if types.report == nil && !types.isLoading { types.refresh() } }
        .onChange(of: types.report?.categories.map(\.id)) { expandPartial() }
        .onAppear { expandPartial() }
        .confirmationDialog(confirmationTitle, isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), presenting: pending) { action in
            switch action {
            case .remove(let category):
                Button("移除规则", role: .destructive) { types.remove([category.id]) }
            case .renormalize(let category, _):
                Button("加入暂存区") { types.add([category.id], renormalize: true) }
            }
        } message: { action in
            switch action {
            case .remove:
                Text("只删除 YunBox 生成的规则，手写或 git lfs track 加的规则保留。已经存为 LFS 指针的文件不会改动，但不再匹配 LFS 规则后会显示为已修改。")
            case .renormalize:
                Text("会加上这一类的 LFS 规则，并对这些文件运行 git add --renormalize：把 .gitattributes 和这些文件当前的内容加入暂存区，从下一次提交起存为 LFS 指针。已有的提交（历史）不变，不会自动提交。")
            }
        }
    }

    private var confirmationTitle: String {
        switch pending {
        case .remove(let category): String(localized: "移除「\(category.title)」的 LFS 规则？")
        case .renormalize(let category, let files): String(localized: "从下一次提交起用 LFS 存储 \(files) 个「\(category.title)」文件？")
        case nil: ""
        }
    }

    /// Open the types that are only partly in LFS, so the extensions that are not stand out.
    private func expandPartial() {
        guard let report = types.report, expanded.isEmpty else { return }
        expanded = Set(report.categories.filter { $0.state == .partial }.map(\.id))
    }

    // MARK: Presets

    private func presets(_ report: AssetTypesReport) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("预置组合").font(.headline)
            HStack(spacing: 8) {
                ForEach(report.presets) { preset in
                    let applied = report.isApplied(preset)
                    Button { types.add([preset.id]) } label: {
                        Label(preset.title, systemImage: applied ? "checkmark" : "plus")
                    }
                    .disabled(applied || types.isApplying)
                    .help(applied
                        ? String(localized: "\(categoryTitles(preset.categories, in: report)) 都已走 LFS")
                        : String(localized: "添加：\(categoryTitles(preset.categories, in: report))（git yunbox types add \(preset.id)）"))
                }
            }
        }
    }

    private func categoryTitles(_ ids: [String], in report: AssetTypesReport) -> String {
        ids.map { id in report.categories.first { $0.id == id }?.title ?? id }.formatted(.list(type: .and))
    }

    // MARK: Categories

    private func categories(_ report: AssetTypesReport) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("类型").font(.headline)
            VStack(spacing: 0) {
                ForEach(Array(report.categories.enumerated()), id: \.element.id) { index, category in
                    if index > 0 { Divider() }
                    CategoryRow(
                        category: category,
                        expanded: Binding(get: { expanded.contains(category.id) }, set: { open in
                            if open { expanded.insert(category.id) } else { expanded.remove(category.id) }
                        }),
                        busy: types.isApplying,
                        add: { types.add([category.id]) },
                        remove: { pending = .remove(category) }
                    )
                }
            }
            .padding(.horizontal, 12)
            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    // MARK: Plain files

    private func plainFiles(_ report: AssetTypesReport) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text("作为普通文件提交的素材（\(report.plainFiles.count) 个）").font(.headline)
            }
            Text("这些文件属于上面的素材类型，但在 Git 里是普通文件，不是 LFS 指针。")
                .font(.callout).foregroundStyle(.secondary)
            ForEach(report.plainFileGroups) { group in
                VStack(alignment: .leading, spacing: 8) {
                    Text(reasonTitle(group.reason)).fontWeight(.medium)
                    Text(reasonDetail(group.reason)).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    ForEach(group.parts) { part in
                        PlainFilePart(part: part, reason: group.reason, busy: types.isApplying) {
                            pending = .renormalize(part.category, files: part.files.count)
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private func reasonTitle(_ reason: AssetTypesReport.PlainFile.Reason) -> LocalizedStringKey {
        switch reason {
        case .case: "扩展名大小写不同"
        case .notRenormalized: "已有 LFS 规则，但提交时还没有"
        case .noRule: "没有 LFS 规则"
        }
    }

    private func reasonDetail(_ reason: AssetTypesReport.PlainFile.Reason) -> LocalizedStringKey {
        switch reason {
        case .case: "规则只写了小写扩展名，区分大小写的系统（Linux、CI）上匹配不到。要单独为这些扩展名加规则，见下面的命令。"
        case .notRenormalized: "这些文件在规则加入之前就提交了，现在会显示为已修改。"
        case .noRule: "这一类还没有 LFS 规则；直接添加类型时，会因为这些文件跳过对应的扩展名。"
        }
    }
}

private struct CategoryRow: View {
    let category: AssetTypesReport.Category
    @Binding var expanded: Bool
    let busy: Bool
    let add: () -> Void
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button { withAnimation(.snappy(duration: 0.2)) { expanded.toggle() } } label: {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 12)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? Text("收起扩展名") : Text("展开扩展名"))
                Image(systemName: stateSymbol).foregroundStyle(stateTint).frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(category.title).fontWeight(.medium)
                        Text(category.id).font(.caption.monospaced()).foregroundStyle(.tertiary)
                    }
                    HStack(spacing: 4) {
                        stateText
                        if category.otherRuleCount > 0 {
                            Text("·")
                            Text("\(category.otherRuleCount) 条来自其他规则")
                        }
                        Text("·")
                        if category.files > 0 {
                            Text("文件 \(category.files) 个，LFS 指针 \(category.lfsFiles) 个")
                        } else {
                            Text("没有文件")
                        }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if category.state != .lfs {
                    Button("添加", action: add).disabled(busy)
                        .help(Text(verbatim: "git yunbox types add \(category.id)"))
                }
                if category.hasManagedRules {
                    Button("移除…", action: remove).disabled(busy)
                        .help(Text(verbatim: "git yunbox types remove \(category.id)"))
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.snappy(duration: 0.2)) { expanded.toggle() } }
            if expanded { extensions.padding(.leading, 50) }
        }
        .padding(.vertical, 10)
    }

    @ViewBuilder private var stateText: some View {
        switch category.state {
        case .lfs: Text("全部走 LFS")
        case .none: Text("未走 LFS")
        case .partial: Text("\(category.trackedCount)/\(category.extensions.count) 走 LFS")
        }
    }

    private var stateSymbol: String {
        switch category.state {
        case .lfs: "checkmark.circle.fill"
        case .partial: "circle.lefthalf.filled"
        case .none: "circle"
        }
    }

    private var stateTint: Color {
        switch category.state {
        case .lfs: .green
        case .partial: .orange
        case .none: .secondary
        }
    }

    private var extensions: some View {
        Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 5) {
            GridRow {
                Text("规则")
                Text("走 LFS")
                Text("来源")
                Text("文件").gridColumnAlignment(.trailing)
                Text("LFS 指针").gridColumnAlignment(.trailing)
            }
            .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            ForEach(category.extensions) { row in
                GridRow {
                    Text(row.pattern).font(.callout.monospaced())
                    Image(systemName: row.lfs ? "checkmark" : "minus")
                        .foregroundStyle(row.lfs ? Color.green : Color.secondary)
                        .accessibilityLabel(row.lfs ? Text("走 LFS") : Text("不走 LFS"))
                    source(row)
                    Text(row.files, format: .number).monospacedDigit().foregroundStyle(row.files > 0 ? .primary : .tertiary)
                    Text(row.lfsFiles, format: .number).monospacedDigit().foregroundStyle(pointerStyle(row))
                }
                .font(.callout)
            }
        }
    }

    /// Orange when some files of this extension are not LFS pointers.
    private func pointerStyle(_ row: AssetTypesReport.Extension) -> AnyShapeStyle {
        if row.files == 0 { return AnyShapeStyle(.tertiary) }
        return row.lfsFiles < row.files ? AnyShapeStyle(.orange) : AnyShapeStyle(.primary)
    }

    @ViewBuilder private func source(_ row: AssetTypesReport.Extension) -> some View {
        if row.managed {
            Text("YunBox").foregroundStyle(.secondary)
        } else if row.lfs {
            Text("来自其他规则")
                .font(.caption).padding(.horizontal, 6).padding(.vertical, 1)
                .background(.orange.opacity(0.15), in: Capsule())
                .help("这条规则是手写的或由 git lfs track 添加，这里不会删除；要改用文本编辑器修改 .gitattributes")
        } else {
            Text("—").foregroundStyle(.tertiary)
        }
    }
}

/// One category's plain files under a reason, with the action that moves them to LFS.
private struct PlainFilePart: View {
    let part: AssetTypesReport.PlainFileGroup.Part
    let reason: AssetTypesReport.PlainFile.Reason
    let busy: Bool
    let renormalize: () -> Void
    private static let shown = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(part.category.title) · \(part.files.count) 个文件").font(.callout.weight(.medium))
                Spacer()
                if reason != .case {
                    Button("从下一次提交起改用 LFS…", action: renormalize).disabled(busy)
                        .help(Text(verbatim: "git yunbox types add \(part.category.id) --renormalize"))
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(part.files.prefix(Self.shown)) { file in
                    Text(file.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                }
                if part.files.count > Self.shown {
                    Text("还有 \(part.files.count - Self.shown) 个").font(.caption).foregroundStyle(.secondary)
                }
            }
            .textSelection(.enabled)
            if reason == .case {
                Text(caseCommands).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    /// The CLI's suggestion for extensions in another case: a rule of their own, then renormalize.
    private var caseCommands: String {
        let patterns = Array(Set(part.files.map { "'*.\($0.extension)'" })).sorted().joined(separator: " ")
        return "git lfs track \(patterns)\ngit add .gitattributes && git add --renormalize -- \(patterns)"
    }
}
