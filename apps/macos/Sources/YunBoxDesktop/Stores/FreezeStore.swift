import AppKit
import Foundation
import Observation
import YunBoxKit

/// Push freeze windows of every recent repository, refreshed in the background for the menu bar.
@MainActor @Observable
final class FreezeStore {
    let inspector: InspectorStore
    /// Latest `yunbox freeze list --json` per repository path; the home directory stands in when no repository is open.
    var statuses: [String: FreezeStatus] = [:]
    var errors: [String: String] = [:]
    var isLoading = false
    var isApplying = false
    /// The CLI's explanation after a failed change.
    var feedback: String?
    /// Repository the editor window should open next; it clears this once loaded.
    var editorPath: String?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var lastFullRefresh = Date.distantPast

    /// Scopes `yunbox freeze set` / `clear` can write, in menu order.
    static let editableScopes: [FreezeStatus.Scope] = [.local, .shared, .global]
    static let homePath = FileManager.default.homeDirectoryForCurrentUser.path

    init(inspector: InspectorStore) {
        self.inspector = inspector
        // The current repository every 30 seconds, the others every few minutes; opening the menu refreshes at once.
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await refresh(all: Date().timeIntervalSince(lastFullRefresh) > 180)
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
    }

    /// The main window's repository, or the home directory for global windows only.
    var currentPath: String { inspector.repository?.path ?? Self.homePath }
    var hasRepository: Bool { inspector.repository != nil }
    var status: FreezeStatus? { statuses[currentPath] }
    var error: String? { errors[currentPath] }
    /// Recent repositories, current first.
    var projectPaths: [String] {
        let recents = inspector.recentPaths
        guard let current = inspector.repository?.path else { return recents }
        return [current] + recents.filter { $0 != current }
    }

    /// Drives the menu bar badge.
    var isFrozen: Bool { status?.check.isFrozen == true }

    /// Windows from `~/.gitconfig`, the same in every repository's status.
    var machineWindows: [FreezeStatus.Window] { (status ?? statuses.values.first)?.machineWindows ?? [] }
    var globalMessage: String? { (status ?? statuses.values.first)?.message(in: .global) }

    /// Refresh the current repository, and with `all` every recent one.
    func refresh(all: Bool = false) async {
        var paths = [currentPath]
        if all {
            paths += projectPaths.filter { $0 != currentPath }
            lastFullRefresh = Date()
        }
        await refresh(paths: paths)
    }

    func refresh(paths: [String]) async {
        let client: InspectionClient
        do {
            client = try inspector.client()
        } catch {
            for path in paths { errors[path] = (error as? LocalizedError)?.errorDescription ?? "检查程序未能运行。" }
            return
        }
        isLoading = true
        defer { isLoading = false }
        // A handful at a time: each is a short-lived Node.js process.
        for chunk in stride(from: 0, to: paths.count, by: 4).map({ Array(paths[$0..<min($0 + 4, paths.count)]) }) {
            let results = await withTaskGroup(of: (String, Result<FreezeStatus, Error>).self) { group in
                for path in chunk {
                    group.addTask {
                        guard FileManager.default.fileExists(atPath: path) else {
                            return (path, .failure(InspectionFailure.cli("找不到这个仓库，可能已移动或删除。")))
                        }
                        do {
                            return (path, .success(try await client.freezeStatus(directory: URL(fileURLWithPath: path))))
                        } catch {
                            return (path, .failure(error))
                        }
                    }
                }
                var collected: [(String, Result<FreezeStatus, Error>)] = []
                for await result in group { collected.append(result) }
                return collected
            }
            for (path, result) in results {
                switch result {
                case .success(let status):
                    statuses[path] = status
                    errors[path] = nil
                case .failure(let error):
                    errors[path] = (error as? LocalizedError)?.errorDescription ?? "无法读取禁推时段。"
                }
            }
        }
        // Forget repositories that left the recent list.
        let known = Set(projectPaths + [Self.homePath])
        for path in statuses.keys where !known.contains(path) { statuses[path] = nil }
    }

    /// Replace `scope`'s windows in `path`; empty `message` / `timeZone` remove the stored ones.
    @discardableResult
    func apply(rules: [String], scope: FreezeStatus.Scope, message: String, timeZone: String, path: String) async -> Bool {
        await run(path: path, scope: scope) { client, directory in
            try await client.setFreeze(directory: directory, rules: rules, scope: scope, message: message, timeZone: timeZone)
        }
    }

    /// Keep `scope`'s message and time zone, replace only its windows. For a project without the pre-push wrapper,
    /// install it too, so the one click is all a project needs.
    @discardableResult
    func apply(preset: FreezePreset, scope: FreezeStatus.Scope, path: String) async -> Bool {
        let applied = await run(path: path, scope: scope) { client, directory in
            try await client.setFreeze(directory: directory, rules: [preset.rules], scope: scope, message: nil, timeZone: nil)
        }
        guard applied, scope != .global, statuses[path]?.hook == FreezeStatus.Hook.none else { return applied }
        if await run(path: path, scope: .local, { client, directory in try await client.installHook(repository: directory) }) {
            feedback = "已为 \(URL(fileURLWithPath: path).lastPathComponent) 安装 pre-push 包装层，禁推时段现在会拦截推送（yunbox hook uninstall 可撤销）。"
        }
        return applied
    }

    /// Choose a Git repository and make it the current project, like opening it in the main window.
    func addProject() {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "添加"
        panel.message = "选择要设置禁推时段的 Git 仓库"
        guard panel.runModal() == .OK, let url = panel.url, inspector.select(url) else { return }
        Task { await refresh(paths: [currentPath]) }
    }

    func clear(scope: FreezeStatus.Scope, path: String) async {
        await run(path: path, scope: scope) { client, directory in try await client.clearFreeze(directory: directory, scope: scope) }
    }

    /// `yunbox freeze off` for this repository (`.local`) or every repository (`.global`).
    func pause(scope: FreezeStatus.Scope, option: FreezePauseOption, path: String) async {
        await run(path: path, scope: scope) { client, directory in try await client.pauseFreeze(directory: directory, scope: scope, option: option) }
    }

    func resume(scope: FreezeStatus.Scope, path: String) async {
        await run(path: path, scope: scope) { client, directory in try await client.resumeFreeze(directory: directory, scope: scope) }
    }

    /// The machine-wide pause, the same in every repository's status.
    var globalPause: FreezeStatus.Pause? { (status ?? statuses.values.first)?.pause(in: .global) }

    func installHook(path: String) async {
        await run(path: path, scope: .local) { client, directory in try await client.installHook(repository: directory) }
    }

    @discardableResult
    private func run(path: String, scope: FreezeStatus.Scope, _ command: (InspectionClient, URL) async throws -> CommandOutput) async -> Bool {
        isApplying = true
        feedback = nil
        defer { isApplying = false }
        var succeeded = false
        do {
            let output = try await command(inspector.client(), URL(fileURLWithPath: path))
            succeeded = output.succeeded
            if !succeeded { feedback = output.text.replacingOccurrences(of: "错误：", with: "").trimmingCharacters(in: .whitespacesAndNewlines) }
        } catch {
            feedback = (error as? LocalizedError)?.errorDescription ?? "命令未能运行。"
        }
        // Global windows show up in every repository.
        if scope == .global { await refresh(all: true) } else { await refresh(paths: [path]) }
        return succeeded
    }
}
