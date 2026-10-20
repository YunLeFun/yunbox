import AppKit
import YunBoxKit

/// Quits and reopens the app, so a new interface language takes effect.
@MainActor
enum AppRelauncher {
    static let bundleIdentifier = Bundle.main.bundleIdentifier ?? "fun.yunle.yunbox.desktop"
    /// The language choice the running interface was loaded with.
    static let launchLanguage = AppLanguage.stored(domain: bundleIdentifier)
    /// Only a real .app can be reopened; `swift run` cannot.
    static var canRelaunch: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    static func relaunch() {
        guard canRelaunch else { return }
        // A detached shell waits for this process to exit, then opens the bundle again, so the two
        // copies never run at the same time.
        let reopen = Process()
        reopen.executableURL = URL(fileURLWithPath: "/bin/sh")
        reopen.arguments = ["-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; /usr/bin/open \"$0\"",
                            Bundle.main.bundleURL.path, String(ProcessInfo.processInfo.processIdentifier)]
        do {
            try reopen.run()
        } catch {
            return
        }
        NSApp.terminate(nil)
    }
}
