import Foundation
import Observation
import YunBoxKit

/// `git yunbox types` for the main window's repository: which asset types go through LFS, and adding or removing them.
@MainActor @Observable
final class AssetTypesStore {
    let inspector: InspectorStore
    var report: AssetTypesReport?
    var error: String?
    var isLoading = false
    var isApplying = false
    var showing = false
    /// What the last add / remove printed, for the repository it ran in.
    var output: CommandOutput?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var requestID = UUID()
    /// Repository `report` and `output` belong to.
    @ObservationIgnored private var reportPath: String?

    init(inspector: InspectorStore) {
        self.inspector = inspector
    }

    /// Read `types list --json` again; a newer call or a repository switch supersedes older ones.
    func refresh() {
        guard let repository = inspector.repository else { return }
        task?.cancel()
        let id = UUID()
        requestID = id
        if reportPath != repository.path {
            report = nil
            output = nil
        }
        error = nil
        isLoading = true
        task = Task {
            do {
                let next = try await inspector.client().assetTypes(repository: repository)
                guard requestID == id else { return }
                report = next
                reportPath = repository.path
            } catch is CancellationError {
            } catch {
                guard requestID == id else { return }
                self.error = (error as? LocalizedError)?.errorDescription ?? String(localized: "检查程序未能运行。请在设置中确认 Node.js 路径。")
            }
            if requestID == id { isLoading = false; task = nil }
        }
    }

    /// `types add` for types or presets; `renormalize` also stages the committed files the new rules catch.
    func add(_ ids: [String], renormalize: Bool = false) {
        run { client, repository in try await client.addAssetTypes(repository: repository, ids: ids, renormalize: renormalize) }
    }

    func remove(_ ids: [String]) {
        run { client, repository in try await client.removeAssetTypes(repository: repository, ids: ids) }
    }

    private func run(_ command: @escaping (InspectionClient, URL) async throws -> CommandOutput) {
        guard let repository = inspector.repository, !isApplying else { return }
        isApplying = true
        output = nil
        Task {
            defer { isApplying = false }
            let result: CommandOutput
            do {
                result = try await command(inspector.client(), repository)
            } catch {
                result = CommandOutput(exitCode: -1, text: (error as? LocalizedError)?.errorDescription ?? String(localized: "命令未能运行。"))
            }
            guard inspector.repository == repository else { return }
            output = result
            reportPath = repository.path
            refresh()
        }
    }
}
