import Foundation
import Observation
import YunBoxKit

@MainActor @Observable
final class PushHistoryStore {
    var report: PushHistoryReport?
    var selectedProject: String?
    var busy = false
    var error: String?

    var entries: [PushHistoryEntry] {
        (report?.entries ?? []).filter { selectedProject == nil || URL(fileURLWithPath: $0.root).standardizedFileURL.path == selectedProject }
    }

    func projects(current: String?) -> [String] {
        Set(((report?.entries.map(\.root) ?? []) + [selectedProject, current].compactMap { $0 }).map { URL(fileURLWithPath: $0).standardizedFileURL.path }).sorted()
    }

    func refresh(inspector: InspectorStore) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do { report = try await inspector.client().pushHistory() }
        catch { self.error = error.localizedDescription }
    }

    func clear(inspector: InspectorStore, project: String?) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            report = try await inspector.client().clearPushHistory(project: project)
            inspector.refreshBlockedPushes()
        } catch { self.error = error.localizedDescription }
    }
}
