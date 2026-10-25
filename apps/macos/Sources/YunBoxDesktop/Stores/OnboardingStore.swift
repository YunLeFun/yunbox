import Foundation
import Observation
import YunBoxKit

@MainActor @Observable
final class OnboardingStore {
    var status: HookStatus?
    var error: String?
    var busy = false
    var scanning = false
    var output: CommandOutput?
    var globally = false
    var confirm = true
    var repositoryStatuses: [String: HookStatus] = [:]
    var unavailable = 0
    private var requestID = UUID()

    var coverage: HookCoverage { HookCoverage(statuses: Array(repositoryStatuses.values), unavailable: unavailable) }
    var attentionPaths: [String] { repositoryStatuses.keys.filter { repositoryStatuses[$0]?.isProtected != true }.sorted() }

    func refresh(inspector: InspectorStore, updateOptions: Bool = true) async {
        let id = UUID()
        requestID = id
        busy = true
        scanning = false
        error = nil
        do {
            let client = try inspector.client()
            let directory = inspector.repository ?? FileManager.default.homeDirectoryForCurrentUser
            let report = try await client.hookStatus(directory: directory)
            guard requestID == id, !Task.isCancelled else { return }
            status = report
            if updateOptions {
                globally = report.globalInstalled
                if report.isProtected { confirm = report.confirm }
            }
            busy = false
            scanning = true
            repositoryStatuses = report.repository ? [directory.path: report] : [:]
            unavailable = 0
            let paths = inspector.repositoryPaths.filter { $0 != directory.path }
            for start in stride(from: 0, to: paths.count, by: 4) {
                let chunk = Array(paths[start..<min(start + 4, paths.count)])
                let results = await withTaskGroup(of: (String, HookStatus?).self) { group in
                    for path in chunk {
                        group.addTask {
                            (path, try? await client.hookStatus(directory: URL(fileURLWithPath: path)))
                        }
                    }
                    var collected: [(String, HookStatus?)] = []
                    for await result in group { collected.append(result) }
                    return collected
                }
                guard requestID == id, !Task.isCancelled else { return }
                for (path, status) in results {
                    if let status { repositoryStatuses[path] = status } else { unavailable += 1 }
                }
            }
        } catch {
            guard requestID == id else { return }
            status = nil
            repositoryStatuses = [:]
            unavailable = inspector.repositoryPaths.count
            self.error = error.localizedDescription
        }
        if requestID == id { busy = false; scanning = false }
    }

    enum Action { case apply, removeGlobal, repair, restore, clearMissing }

    func install(inspector: InspectorStore, action: Action = .apply) async {
        guard let repository = inspector.repository, !busy else { return }
        requestID = UUID()
        busy = true
        error = nil
        do {
            let client = try inspector.client()
            var result: CommandOutput
            switch action {
            case .removeGlobal: result = try await client.uninstallGlobalHook(directory: repository)
            case .repair: result = try await client.repairHook(repository: repository, confirm: confirm)
            case .restore: result = try await client.uninstallHook(repository: repository)
            case .clearMissing: result = try await client.clearMissingHook(repository: repository)
            case .apply:
                let compatible = status?.customPath == true || status?.compatibility?.registered == true
                result = try await client.installHook(repository: repository, globally: globally, confirm: confirm, compatible: compatible)
                if result.succeeded && globally && (compatible || status?.scope == "repository") {
                    result = try await client.installHook(repository: repository, confirm: confirm, compatible: compatible)
                }
            }
            output = result
            await refresh(inspector: inspector)
            if result.exitCode != 0 { error = result.text }
        } catch {
            self.error = error.localizedDescription
            busy = false
        }
    }
}
