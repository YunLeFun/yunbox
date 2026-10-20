import AppKit
import SwiftUI
import YunBoxKit

@main
struct YunBoxApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store: InspectorStore
    @State private var freeze: FreezeStore
    @State private var updater = UpdaterStore()
    @AppStorage("showMenuBarExtra") private var showMenuBarExtra = true

    init() {
        let store = InspectorStore()
        _store = State(initialValue: store)
        _freeze = State(initialValue: FreezeStore(inspector: store))
    }

    var body: some Scene {
        Window("云匣 YunBox", id: "main") {
            ContentView(store: store)
                .frame(minWidth: 880, minHeight: 600)
                .onOpenURL { store.select($0) }
                .task { if store.repository != nil { store.inspect(); store.checkCos() } }
        }
        .defaultSize(width: 1120, height: 760)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("检查更新…") { updater.checkForUpdates() }
                    .disabled(!updater.canCheckForUpdates)
            }
            CommandGroup(replacing: .newItem) {
                Button("打开仓库…") { store.choosingRepository = true }.keyboardShortcut("o")
                Menu("最近的仓库") {
                    ForEach(Array(store.recentPaths.enumerated()), id: \.element) { index, path in
                        RecentRepositoryButton(store: store, index: index, path: path)
                    }
                    if !store.recentPaths.isEmpty { Divider() }
                    Button("清除最近列表") { store.clearRecents() }
                        .disabled(store.recentPaths.allSatisfy { $0 == store.repository?.path })
                }
            }
            CommandGroup(replacing: .help) {
                ForEach([DocsPage.quickStart, .macOS, .freeze, .inspect, .ai]) { page in
                    Link(page == .quickStart ? String(localized: "云匣使用说明") : page.title, destination: page.url)
                }
                Link(DocsPage.changelog.title, destination: DocsPage.changelog.url)
                Divider()
                Link("GitHub 仓库", destination: DocsPage.repository)
            }
            CommandMenu("检查") {
                Button("重新检查") { store.inspect() }.keyboardShortcut("r").disabled(store.isInspecting)
                Button("取消检查") { store.cancel() }.keyboardShortcut(".").disabled(!store.isInspecting)
                Divider()
                Button("复制 JSON 报告") { store.copyJSON() }.keyboardShortcut("c", modifiers: [.command, .shift]).disabled(store.result == nil)
            }
        }
        Settings { SettingsView(updater: updater) }
        Window("禁推时段", id: "freeze") {
            FreezeEditorView(freeze: freeze)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
        MenuBarExtra(isInserted: $showMenuBarExtra) {
            FreezePanel(freeze: freeze)
        } label: {
            Image(nsImage: MenuBarIcon.image(badge: freeze.isFrozen))
        }
        .menuBarExtraStyle(.window)
    }
}

/// One "最近的仓库" menu item; the first nine get ⌘1–⌘9.
private struct RecentRepositoryButton: View {
    let store: InspectorStore
    let index: Int
    let path: String

    var body: some View {
        let url = URL(fileURLWithPath: path)
        let button = Button("\(url.lastPathComponent) — \(url.deletingLastPathComponent().lastPathComponent)") {
            store.select(url)
        }
        if index < RecentRepositories.shortcutCount {
            button.keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
        } else {
            button
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}
