import AppKit
import Observation
import YunBoxKit

@MainActor @Observable
final class InspectorStore {
    var repository: URL?
    var recentPaths: [String]
    var result: InspectionResult?
    var rows: [FileRow] = []
    var isInspecting = false
    var error: String?
    var checkedAt: Date?
    var query = ""
    var kind = "全部"
    var onlyExceeded = false
    var selectedFile: String?
    var choosingRepository = false
    var copiedJSON = false
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var copyFeedback: Task<Void, Never>?
    @ObservationIgnored private var requestID = UUID()

    init() {
        recentPaths = UserDefaults.standard.stringArray(forKey: "recentRepositories") ?? []
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--repository"), args.indices.contains(index + 1) {
            repository = URL(fileURLWithPath: args[index + 1])
        } else if let first = recentPaths.first {
            repository = URL(fileURLWithPath: first)
        }
    }

    var visibleRows: [FileRow] {
        rows.filter { (kind == "全部" || $0.kind.rawValue == kind) && (!onlyExceeded || $0.object.exceedsFileLimit) && $0.matches(query) }
    }

    var selectedRow: FileRow? { visibleRows.first { $0.id == selectedFile } }

    @discardableResult func select(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        guard url.isFileURL, FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            error = "请选择本机的 Git 仓库文件夹。"
            return false
        }
        var root = url.standardizedFileURL
        while root.path != "/", !FileManager.default.fileExists(atPath: root.appendingPathComponent(".git").path) {
            root.deleteLastPathComponent()
        }
        if root.path == "/" { root = url.standardizedFileURL }
        repository = root
        recentPaths = [root.path] + recentPaths.filter { $0 != root.path }
        recentPaths = Array(recentPaths.prefix(12))
        UserDefaults.standard.set(recentPaths, forKey: "recentRepositories")
        inspect()
        return true
    }

    func forget(_ path: String) {
        recentPaths.removeAll { $0 == path }
        UserDefaults.standard.set(recentPaths, forKey: "recentRepositories")
    }

    func inspect() {
        guard let repository else { choosingRepository = true; return }
        task?.cancel()
        let id = UUID()
        requestID = id
        result = nil
        rows = []
        selectedFile = nil
        error = nil
        checkedAt = nil
        copiedJSON = false
        isInspecting = true
        task = Task {
            do {
                let defaults = UserDefaults.standard
                let client = try InspectionClient.bundled(nodeOverride: defaults.string(forKey: "nodePath") ?? "")
                var limits: [String] = []
                if defaults.bool(forKey: "overrideLimits") {
                    limits = ["--git-limit", defaults.string(forKey: "gitLimit") ?? "900k",
                              "--lfs-limit", defaults.string(forKey: "lfsLimit") ?? "100m",
                              "--file-limit", defaults.string(forKey: "fileLimit") ?? "10m"]
                }
                let next = try await client.inspect(repository: repository, limits: limits)
                guard requestID == id else { return }
                result = next
                rows = next.report.files
                checkedAt = Date()
            } catch is CancellationError {
                // A new selection or explicit cancellation owns the current UI state.
            } catch {
                guard requestID == id else { return }
                self.error = (error as? InspectionFailure)?.localizedDescription
                    ?? "检查程序未能运行。请在设置中确认 Node.js 路径，或重新安装应用。"
            }
            if requestID == id { isInspecting = false; task = nil }
        }
    }

    func cancel() {
        requestID = UUID()
        task?.cancel()
        task = nil
        isInspecting = false
    }

    func copyJSON() {
        guard let json = result?.json, let text = String(data: json, encoding: .utf8) else { return }
        NSPasteboard.general.clearContents()
        copiedJSON = NSPasteboard.general.setString(text, forType: .string)
        copyFeedback?.cancel()
        copyFeedback = Task {
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            copiedJSON = false
        }
    }

    func reveal(_ row: FileRow) {
        guard let repository, let path = row.object.paths.first else { return }
        let file = repository.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(repository.standardizedFileURL.path + "/"), FileManager.default.fileExists(atPath: file.path) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([file])
    }
}
