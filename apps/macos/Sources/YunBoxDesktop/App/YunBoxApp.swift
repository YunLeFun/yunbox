import AppKit
import SwiftUI

@main
struct YunBoxApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store = InspectorStore()

    var body: some Scene {
        Window("云匣 YunBox", id: "main") {
            ContentView(store: store)
                .frame(minWidth: 880, minHeight: 600)
                .onOpenURL { store.select($0) }
                .task { if store.repository != nil { store.inspect() } }
        }
        .defaultSize(width: 1120, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("打开仓库…") { store.choosingRepository = true }.keyboardShortcut("o")
            }
            CommandMenu("检查") {
                Button("重新检查") { store.inspect() }.keyboardShortcut("r").disabled(store.isInspecting)
                Button("取消检查") { store.cancel() }.keyboardShortcut(".").disabled(!store.isInspecting)
                Divider()
                Button("复制 JSON 报告") { store.copyJSON() }.keyboardShortcut("c", modifiers: [.command, .shift]).disabled(store.result == nil)
            }
        }
        Settings { SettingsView() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}
