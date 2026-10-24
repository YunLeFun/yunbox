import Foundation
import Observation
import YunBoxKit

@MainActor @Observable
final class OnboardingStore {
    var status: HookStatus?
    var error: String?
    var busy = false
    var output: CommandOutput?
    var globally = false
    var confirm = true
    private var requestID = UUID()

    func refresh(inspector: InspectorStore) async {
        let id = UUID()
        requestID = id
        busy = true
        error = nil
        status = nil
        do {
            let report = try await inspector.client().hookStatus(directory: inspector.repository ?? FileManager.default.homeDirectoryForCurrentUser)
            guard requestID == id else { return }
            status = report
            if report.isProtected {
                confirm = report.confirm
                globally = report.globalInstalled
            }
        } catch {
            guard requestID == id else { return }
            self.error = error.localizedDescription
        }
        if requestID == id { busy = false }
    }

    func install(inspector: InspectorStore, removeGlobal: Bool = false) async {
        guard let repository = inspector.repository, !busy else { return }
        busy = true
        error = nil
        do {
            let client = try inspector.client()
            var result = try await (removeGlobal
                ? client.uninstallGlobalHook(directory: repository)
                : client.installHook(repository: repository, globally: globally, confirm: confirm))
            if result.succeeded && !removeGlobal && globally && status?.scope == "repository" {
                result = try await client.installHook(repository: repository, confirm: confirm)
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
