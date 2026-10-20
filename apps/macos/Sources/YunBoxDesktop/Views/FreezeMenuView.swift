import AppKit
import SwiftUI
import YunBoxKit

/// Menu bar panel in the style of the system's Wi-Fi and Bluetooth menus: the current repository's verdict with
/// today's timeline, the week ahead, machine-wide rules, and every recent project with its own rules.
struct FreezePanel: View {
    @Bindable var freeze: FreezeStore
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openURL) private var openURL
    @State var expanded: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            CurrentStatus(freeze: freeze)
            if let week = freeze.status?.week, week.contains(where: { !$0.spans.isEmpty }) {
                MenuDivider()
                SectionTitle("未来 7 天")
                WeekOverview(days: week)
            }
            MenuDivider()
            SectionTitle("全局规则", detail: "本机所有仓库") { presetMenu(scope: .global, path: freeze.currentPath) }
            globalRules
            MenuDivider()
            SectionTitle("项目", detail: "每个项目单独设置")
            projects
            MenuDivider()
            MenuRow(title: "编辑禁推时段…", symbol: "slider.horizontal.3") { edit(path: freeze.currentPath) }
            MenuRow(title: "打开云匣", symbol: "macwindow") { show("main") }
            MenuRow(title: "使用说明", symbol: "questionmark.circle") { openURL(DocsPage.freeze.url) }
            SettingsLink { MenuRowLabel(title: "设置…", symbol: "gearshape") }.buttonStyle(MenuRowStyle())
            MenuRow(title: "退出云匣", symbol: "power") { NSApp.terminate(nil) }
        }
        .padding(6)
        .frame(width: 340)
        .task { await freeze.refresh(all: true) }
    }

    private var header: some View {
        HStack {
            Text("推送时段").font(.system(size: 13, weight: .semibold))
            Spacer()
            if freeze.isLoading || freeze.isApplying { ProgressView().controlSize(.mini) }
            Button { Task { await freeze.refresh(all: true) } } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.borderless)
            .help("刷新全部项目")
            PauseMenu(freeze: freeze, scope: .global, path: freeze.currentPath, symbol: "timer")
                .help("定时关闭本机所有仓库的禁推时段")
            Toggle("禁推时段", isOn: Binding(
                get: { freeze.globalPause == nil },
                set: { on in
                    Task {
                        if on {
                            await freeze.resume(scope: .global, path: freeze.currentPath)
                        } else {
                            await freeze.pause(scope: .global, option: FreezePauseOption.all.last!, path: freeze.currentPath)
                        }
                    }
                }
            ))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .labelsHidden()
            .disabled(freeze.isApplying || freeze.status == nil)
            .help(freeze.globalPause == nil ? "关闭本机所有仓库的禁推时段（规则保留）" : "恢复本机所有仓库的禁推时段")
        }
        .padding(.horizontal, 8).padding(.top, 4).padding(.bottom, 6)
    }

    @ViewBuilder private var globalRules: some View {
        let windows = freeze.machineWindows
        if windows.isEmpty {
            InfoRow(symbol: "globe", tint: .gray, title: String(localized: "没有全局规则"), subtitle: String(localized: "在右上角「＋」选择预设，对本机所有仓库生效"))
        } else {
            ForEach(windows) { window in
                InfoRow(symbol: "globe", tint: .accentColor, title: window.window,
                        subtitle: [window.scope.shortLabel, window.timeZone, freeze.globalMessage].compactMap { $0 }.joined(separator: " · "))
            }
        }
    }

    @ViewBuilder private var projects: some View {
        if freeze.projectPaths.isEmpty {
            InfoRow(symbol: "folder", tint: .gray, title: String(localized: "还没有项目"), subtitle: String(localized: "点「添加项目…」选择 Git 仓库"))
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(freeze.projectPaths, id: \.self) { path in
                        ProjectRow(freeze: freeze, path: path, isCurrent: path == freeze.inspector.repository?.path,
                                   isExpanded: expanded == path,
                                   toggle: { withAnimation(.snappy(duration: 0.2)) { expanded = expanded == path ? nil : path } },
                                   presets: { scope in presetMenu(scope: scope, path: path) },
                                   edit: { edit(path: path) })
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 300)
            .fixedSize(horizontal: false, vertical: freeze.projectPaths.count <= 5)
        }
        MenuRow(title: "添加项目…", symbol: "plus") { freeze.addProject() }
    }

    /// Checkable presets for one scope of one repository: checking replaces the scope's rules, unchecking clears them.
    private func presetMenu(scope: FreezeStatus.Scope, path: String) -> some View {
        Menu {
            ForEach(FreezePreset.all) { preset in
                Toggle("\(preset.title)　\(preset.rules)", isOn: presetBinding(preset, scope: scope, path: path))
            }
            Divider()
            Button("清除\(scope.shortLabel)规则") { Task { await freeze.clear(scope: scope, path: path) } }
                .disabled(freeze.statuses[path]?.windows(in: scope).isEmpty ?? true)
        } label: {
            Image(systemName: "plus.circle")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(freeze.isApplying)
        .help("\(scope.shortLabel)预设")
    }

    private func presetBinding(_ preset: FreezePreset, scope: FreezeStatus.Scope, path: String) -> Binding<Bool> {
        Binding(
            get: {
                let windows: [String] = freeze.statuses[path]?.windows(in: scope).map(\.window) ?? []
                return windows == [preset.rules]
            },
            set: { on in
                Task {
                    if on { await freeze.apply(preset: preset, scope: scope, path: path) } else { await freeze.clear(scope: scope, path: path) }
                }
            }
        )
    }

    private func edit(path: String) {
        freeze.editorPath = path
        show("freeze")
    }

    private func show(_ id: String) {
        openWindow(id: id)
        NSApp.activate(ignoringOtherApps: true)
    }
}

/// For rendering the panel outside the menu bar, e.g. in screenshots.
struct FreezePanelPreview: View {
    let freeze: FreezeStore
    let expanded: String?

    var body: some View {
        FreezePanel(freeze: freeze, expanded: expanded)
            .background(Color(nsColor: .windowBackgroundColor))
    }
}

// MARK: - Current repository

private struct CurrentStatus: View {
    let freeze: FreezeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                IconCircle(symbol: symbol, tint: tint, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 13, weight: .semibold))
                    Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            if let pause = freeze.status?.check.pause {
                HStack(spacing: 6) {
                    Image(systemName: "pause.circle.fill").foregroundStyle(.orange)
                    Text("已关闭（\(pause.scope.shortLabel)）· \(pause.label())").font(.system(size: 11))
                    Spacer(minLength: 0)
                    Button("恢复") { Task { await freeze.resume(scope: pause.scope, path: freeze.currentPath) } }
                        .controlSize(.small).disabled(freeze.isApplying)
                }
            }
            if let message = freeze.status?.check.message {
                Text(message).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
            }
            if let today = freeze.status?.week?.first {
                Group {
                    DayTimeline(day: today, showsNow: true, height: 8)
                    HourLabels()
                }
                .opacity(freeze.status?.check.pause == nil ? 1 : 0.45)
            }
            if let status = freeze.status, status.isUnenforced {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(status.hook == .guard ? "包装层使用 --guard，不检查禁推时段" : "没有安装 pre-push 包装层，推送不会被拦截")
                        .font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if status.hook == FreezeStatus.Hook.none {
                        Button("安装") { Task { await freeze.installHook(path: freeze.currentPath) } }
                            .controlSize(.small).disabled(freeze.isApplying)
                    }
                }
            }
            if let feedback = freeze.feedback {
                Text(feedback).font(.system(size: 11)).foregroundStyle(.orange).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 2)
    }

    private var repository: String { freeze.inspector.repository?.lastPathComponent ?? String(localized: "未选择仓库") }

    private var title: String {
        guard let check = freeze.status?.check else { return freeze.error == nil ? String(localized: "正在读取…") : String(localized: "无法读取禁推时段") }
        if check.isPaused { return String(localized: "现在可以推送（禁推已关闭）") }
        return check.isFrozen ? String(localized: "禁推中") : String(localized: "现在可以推送")
    }

    private var subtitle: String {
        guard let status = freeze.status else { return freeze.error ?? repository }
        let check = status.check
        if check.isFrozen, let window = check.window, let scope = check.scope {
            return String(localized: "\(repository) · \(check.opensLabel)\n\(window)（\(scope.shortLabel)）")
        }
        if check.isPaused, let window = check.window {
            return String(localized: "\(repository) · 本应禁推：\(window)")
        }
        if let next = nextFreeze(status) { return "\(repository) · \(next)" }
        return "\(repository) · \(status.windows.isEmpty ? String(localized: "没有设置禁推时段") : String(localized: "未来 7 天没有禁推"))"
    }

    /// "今天 18:00 开始禁推" from the first frozen stretch after now.
    private func nextFreeze(_ status: FreezeStatus) -> String? {
        guard let week = status.week else { return nil }
        let now = Calendar.current.dateComponents([.hour, .minute], from: Date())
        let minute = (now.hour ?? 0) * 60 + (now.minute ?? 0)
        for (offset, day) in week.enumerated() {
            guard let span = day.spans.first(where: { offset > 0 || $0.startMinute > minute }) else { continue }
            let label = offset == 0 ? String(localized: "今天") : offset == 1 ? String(localized: "明天") : day.label
            return String(localized: "\(label) \(span.start) 开始禁推")
        }
        return nil
    }

    private var symbol: String {
        guard let check = freeze.status?.check else { return "questionmark" }
        if check.pause != nil { return "pause.fill" }
        return check.isFrozen ? "hand.raised.fill" : "arrow.up"
    }

    private var tint: Color {
        guard let check = freeze.status?.check else { return .gray }
        if check.pause != nil { return .orange }
        return check.isFrozen ? .red : .green
    }
}

/// The seven days from today, each with its frozen stretches.
private struct WeekOverview: View {
    let days: [FreezeStatus.Day]

    var body: some View {
        VStack(spacing: 5) {
            ForEach(Array(days.enumerated()), id: \.element.id) { offset, day in
                HStack(spacing: 8) {
                    Text(offset == 0 ? String(localized: "今天") : day.label)
                        .font(.system(size: 11, weight: offset == 0 ? .semibold : .regular))
                        .frame(width: 36, alignment: .leading)
                    DayTimeline(day: day, showsNow: offset == 0, height: 6)
                    Text(hours(day.frozenMinutes))
                        .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                        .frame(width: 54, alignment: .trailing)
                }
            }
            HStack(spacing: 8) {
                Color.clear.frame(width: 36, height: 1)
                HourLabels()
                Color.clear.frame(width: 54, height: 1)
            }
        }
        .padding(.horizontal, 8).padding(.bottom, 4)
    }

    private func hours(_ minutes: Int) -> String {
        if minutes == 0 { return "—" }
        if minutes % 60 == 0 { return String(localized: "\(minutes / 60) 小时") }
        return String(localized: "\((Double(minutes) / 60).formatted(.number.precision(.fractionLength(1)))) 小时")
    }
}

/// A 24-hour bar with frozen stretches in red and, for today, a marker at the current time.
private struct DayTimeline: View {
    let day: FreezeStatus.Day
    let showsNow: Bool
    let height: CGFloat

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08)).frame(height: height)
                ForEach(Array(day.spans.enumerated()), id: \.offset) { _, span in
                    Capsule()
                        .fill(Color.red.opacity(0.75))
                        .frame(width: max(2, width * CGFloat(span.endMinute - span.startMinute) / 1440), height: height)
                        .offset(x: width * CGFloat(span.startMinute) / 1440)
                }
                if showsNow {
                    Capsule()
                        .fill(Color.primary)
                        .frame(width: 2, height: height + 6)
                        .offset(x: width * CGFloat(currentMinute) / 1440 - 1)
                }
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: height + 6)
        .accessibilityElement()
        .accessibilityLabel(day.spans.isEmpty
            ? String(localized: "\(day.label)没有禁推")
            : String(localized: "\(day.label)禁推 \(day.spans.map { String(localized: "\($0.start) 到 \($0.end)") }.formatted(.list(type: .and)))"))
    }

    private var currentMinute: Int {
        let now = Calendar.current.dateComponents([.hour, .minute], from: Date())
        return (now.hour ?? 0) * 60 + (now.minute ?? 0)
    }
}

private struct HourLabels: View {
    var body: some View {
        HStack(spacing: 0) {
            ForEach([0, 6, 12, 18, 24], id: \.self) { hour in
                Text("\(hour)")
                    .font(.system(size: 9).monospacedDigit()).foregroundStyle(.tertiary)
                if hour < 24 { Spacer(minLength: 0) }
            }
        }
    }
}

// MARK: - Projects

private struct ProjectRow<Presets: View>: View {
    let freeze: FreezeStore
    let path: String
    let isCurrent: Bool
    let isExpanded: Bool
    let toggle: () -> Void
    let presets: (FreezeStatus.Scope) -> Presets
    let edit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 10) {
                    IconCircle(symbol: status?.check.isFrozen == true ? "hand.raised.fill" : status?.check.pause != nil ? "pause.fill" : "folder.fill", tint: tint, size: 26)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 4) {
                            Text(name).font(.system(size: 13)).lineLimit(1)
                            if isCurrent {
                                Text("当前").font(.system(size: 9, weight: .medium))
                                    .padding(.horizontal, 4).padding(.vertical, 1)
                                    .background(.quaternary, in: Capsule())
                            }
                        }
                        Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }
            .buttonStyle(MenuRowStyle())
            if isExpanded { details.padding(.leading, 44).padding(.trailing, 8).padding(.bottom, 6) }
        }
    }

    private var status: FreezeStatus? { freeze.statuses[path] }
    private var name: String { URL(fileURLWithPath: path).lastPathComponent }

    private var tint: Color {
        guard let status else { return .gray }
        if status.check.isFrozen { return .red }
        if status.check.pause != nil { return .orange }
        return status.projectWindows.isEmpty ? .gray : .accentColor
    }

    private var subtitle: String {
        if let error = freeze.errors[path], status == nil { return error }
        guard let status else { return String(localized: "正在读取…") }
        let rules = status.projectWindows.map(\.window).joined(separator: "；")
        if status.check.isFrozen { return String(localized: "禁推中 · \(status.check.opensLabel)") }
        if let pause = status.check.pause { return String(localized: "已关闭（\(pause.scope.shortLabel)）· \(pause.label())") }
        if rules.isEmpty { return status.machineWindows.isEmpty ? String(localized: "未设置规则") : String(localized: "只有全局规则") }
        guard status.isUnenforced else { return rules }
        return "\(rules) · \(status.hook == .guard ? String(localized: "包装层不检查时段") : String(localized: "未安装包装层"))"
    }

    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach([FreezeStatus.Scope.local, .shared], id: \.self) { scope in
                let windows = status?.windows(in: scope) ?? []
                HStack(alignment: .firstTextBaseline) {
                    Text(scope.shortLabel).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 40, alignment: .leading)
                    Text(windows.isEmpty ? String(localized: "未设置") : windows.map(\.window).joined(separator: "\n"))
                        .font(.system(size: 11).monospaced())
                        .foregroundStyle(windows.isEmpty ? .tertiary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    presets(scope)
                }
            }
            if let message = status?.message(in: .local) ?? status?.message(in: .shared) {
                Text(message).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if status?.pause(in: .local) != nil {
                    Button("恢复") { Task { await freeze.resume(scope: .local, path: path) } }
                        .controlSize(.small).disabled(freeze.isApplying)
                } else if !(status?.windows.isEmpty ?? true) {
                    PauseMenu(freeze: freeze, scope: .local, path: path, title: "暂时关闭")
                }
                if status?.isUnenforced == true, status?.hook == FreezeStatus.Hook.none {
                    Button("安装包装层") { Task { await freeze.installHook(path: path) } }
                        .help("运行 yunbox hook install，让 pre-push 拦截禁推时段")
                        .controlSize(.small).disabled(freeze.isApplying)
                }
                Spacer()
                if !isCurrent {
                    Button("设为当前") {
                        freeze.inspector.select(URL(fileURLWithPath: path))
                        Task { await freeze.refresh(paths: [path]) }
                    }
                    .controlSize(.small)
                    .help("切换主窗口和菜单栏图标到这个项目")
                }
                Button("编辑…", action: edit).controlSize(.small)
            }
        }
    }
}

// MARK: - Menu building blocks

/// Durations for `yunbox freeze off`, as a compact menu button.
private struct PauseMenu: View {
    let freeze: FreezeStore
    let scope: FreezeStatus.Scope
    let path: String
    var symbol: String?
    var title: LocalizedStringKey?

    var body: some View {
        Menu {
            Section(scope == .global ? "关闭本机所有仓库的禁推时段" : "关闭这个项目的禁推时段") {
                ForEach(FreezePauseOption.all) { option in
                    Button(option.title) { Task { await freeze.pause(scope: scope, option: option, path: path) } }
                }
            }
            if freeze.statuses[path]?.pause(in: scope) != nil {
                Divider()
                Button("恢复") { Task { await freeze.resume(scope: scope, path: path) } }
            }
        } label: {
            if let symbol { Image(systemName: symbol) } else { Text(title ?? "关闭") }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(title == nil ? .hidden : .visible)
        .fixedSize()
        .controlSize(.small)
        .disabled(freeze.isApplying || freeze.status == nil)
    }
}

/// A full-width row that highlights on hover like a system menu item.
private struct MenuRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HoverRow(isPressed: configuration.isPressed) { configuration.label }
    }
}

private struct HoverRow<Content: View>: View {
    let isPressed: Bool
    @ViewBuilder let content: Content
    @State private var isHovered = false

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(isPressed ? 0.15 : isHovered ? 0.08 : 0)))
            .onHover { isHovered = $0 }
    }
}

private struct MenuRow: View {
    let title: LocalizedStringKey
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { MenuRowLabel(title: title, symbol: symbol) }.buttonStyle(MenuRowStyle())
    }
}

private struct MenuRowLabel: View {
    let title: LocalizedStringKey
    let symbol: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).frame(width: 16).foregroundStyle(.secondary)
            Text(title)
        }
        .font(.system(size: 13))
    }
}

/// Information that does not act, laid out like a menu row.
private struct InfoRow: View {
    let symbol: String
    let tint: Color
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 10) {
            IconCircle(symbol: symbol, tint: tint, size: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 13)).lineLimit(2)
                if !subtitle.isEmpty { Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
    }
}

private struct IconCircle: View {
    let symbol: String
    let tint: Color
    let size: CGFloat

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(tint.gradient))
    }
}

private struct SectionTitle<Accessory: View>: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey?
    let accessory: Accessory

    init(_ title: LocalizedStringKey, detail: LocalizedStringKey? = nil, @ViewBuilder accessory: () -> Accessory = { EmptyView() }) {
        self.title = title
        self.detail = detail
        self.accessory = accessory()
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            if let detail { Text(detail).font(.system(size: 11)).foregroundStyle(.tertiary) }
            Spacer()
            accessory
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
    }
}

private struct MenuDivider: View {
    var body: some View {
        Divider().padding(.horizontal, 8).padding(.vertical, 5)
    }
}

// MARK: - Editor window

/// Native form for writing one repository's (or the machine's) rules, message and time zone.
struct FreezeEditorView: View {
    @Bindable var freeze: FreezeStore
    @State private var path = ""
    @State private var scope: FreezeStatus.Scope = .local
    @State private var rules = ""
    @State private var message = ""
    @State private var timeZone = ""
    @State private var loaded: String?

    var body: some View {
        Form {
            Section {
                Picker("项目", selection: $path) {
                    ForEach(freeze.projectPaths, id: \.self) { path in
                        Text(URL(fileURLWithPath: path).lastPathComponent).tag(path)
                    }
                    Text("不针对项目（只设置全局）").tag(FreezeStore.homePath)
                }
                LabeledContent("现在") {
                    if let check = freeze.statuses[path]?.check {
                        Text(check.isFrozen ? "禁推中 · \(check.opensLabel)" : "可以推送")
                            .foregroundStyle(check.isFrozen ? .red : .secondary)
                    } else {
                        Text(freeze.errors[path] ?? String(localized: "正在读取…")).foregroundStyle(.secondary)
                    }
                }
            }
            Section {
                Picker("保存到", selection: $scope) {
                    ForEach(FreezeStore.editableScopes, id: \.self) { scope in
                        Text(scope.shortLabel).tag(scope)
                    }
                }
                .pickerStyle(.segmented)
            } footer: {
                Text(scopeHint).font(.caption).foregroundStyle(.secondary)
            }
            Section {
                TextField("规则", text: $rules, prompt: Text("Mo-Fr 09:00-18:00"), axis: .vertical)
                    .font(.body.monospaced())
                    .lineLimit(2...6)
                Menu("插入预设") {
                    ForEach(FreezePreset.all) { preset in
                        Button("\(preset.title)　\(preset.rules)") {
                            rules = rules.isEmpty ? preset.rules : "\(rules)\n\(preset.rules)"
                        }
                    }
                }
                .fixedSize()
            } header: {
                Text("禁推时段")
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("opening_hours 写法，每行一组规则，例如 Mo-Fr 09:00-12:00,14:00-18:00; We off。各行同时生效；同一行里后面的规则覆盖前面同一天的设置。")
                    Link("查看时段写法和常见场景", destination: DocsPage.freezeSyntax.url)
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Section("拦截时显示") {
                TextField("说明", text: $message, prompt: Text("例如：工作时间禁止推送，请在 18:00 后推送"))
                LabeledContent("时区") {
                    HStack {
                        TextField("时区", text: $timeZone, prompt: Text("各自电脑的时区"))
                            .labelsHidden()
                        Button("使用本机时区") { timeZone = TimeZone.current.identifier }
                    }
                }
            }
            if let feedback = freeze.feedback {
                Section { Text(feedback).foregroundStyle(.orange).textSelection(.enabled) }
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button("清除\(scope.shortLabel)规则", role: .destructive) { Task { await freeze.clear(scope: scope, path: path) } }
                    .disabled(freeze.statuses[path]?.windows(in: scope).isEmpty ?? true)
                Spacer()
                Button("还原") { load(force: true) }
                Button("应用") { Task { await apply() } }
                    .keyboardShortcut(.defaultAction)
            }
            .disabled(freeze.isApplying || !isWritable)
            .padding([.horizontal, .bottom], 20)
        }
        .task { await open(freeze.editorPath ?? freeze.currentPath) }
        .onChange(of: freeze.editorPath) { _, target in if let target { Task { await open(target) } } }
        .onChange(of: path) { load(force: true) }
        .onChange(of: scope) { load(force: true) }
        .onChange(of: freeze.statuses[path]) { load(force: false) }
    }

    private var isWritable: Bool { scope == .global || path != FreezeStore.homePath }

    private var scopeHint: String {
        switch scope {
        case .shared: String(localized: "写进这个项目的 .yunbox/config，提交后对整个团队生效；每份 clone 仍需安装 pre-push 包装层。")
        case .global: String(localized: "写进 ~/.gitconfig，对这台电脑上的所有仓库生效。")
        default: String(localized: "写进这个项目的 .git/config，只影响这份 clone。")
        }
    }

    private func open(_ target: String) async {
        path = target
        scope = target == FreezeStore.homePath ? .global : .local
        freeze.editorPath = nil
        await freeze.refresh(paths: [target])
        load(force: true)
    }

    private func apply() async {
        let lines = rules.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if lines.isEmpty {
            await freeze.clear(scope: scope, path: path)
        } else {
            await freeze.apply(rules: lines, scope: scope, message: message, timeZone: timeZone, path: path)
        }
        load(force: true)
    }

    /// Fill the form from the stored state; without `force` only the first time, so edits survive refreshes.
    private func load(force: Bool) {
        let key = "\(path)|\(scope.rawValue)"
        guard let status = freeze.statuses[path], force || loaded != key else { return }
        let windows = status.windows(in: scope)
        rules = windows.map(\.window).joined(separator: "\n")
        message = status.message(in: scope) ?? ""
        timeZone = windows.first?.timeZone ?? ""
        loaded = key
    }
}

extension FreezeStatus.Scope {
    /// Short names for menus and pickers.
    var shortLabel: String {
        switch self {
        case .local: String(localized: "本仓库")
        case .shared: String(localized: "团队")
        case .global: String(localized: "全局")
        default: label
        }
    }
}
