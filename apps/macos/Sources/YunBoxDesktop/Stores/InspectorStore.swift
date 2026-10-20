import AppKit
import Observation
import YunBoxKit

@MainActor @Observable
final class InspectorStore {
    var repository: URL?
    var recents: RecentRepositories
    /// Repositories whose push the pre-push hook stopped lately, from the CLI's record; newest first.
    private(set) var blockedPushes: [BlockedPush] = []
    var result: InspectionResult? {
        didSet { changeIndex = result?.report.changeIndex() ?? [:] }
    }
    /// The change each file row belongs to, by row ID.
    private(set) var changeIndex: [String: InspectionReport.Change] = [:]
    /// True while `result` comes from the on-disk cache and a fresh inspection has not replaced it.
    var isShowingCache = false
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
    /// `yunbox doctor` for the current repository: direct-storage (COS or S3) status and every check.
    var storageReport: DoctorReport?
    var isCheckingStorage = false
    var storageError: String?
    var showingStorage = false
    @ObservationIgnored private var storageTask: Task<Void, Never>?
    @ObservationIgnored private var storageRequestID = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var copyFeedback: Task<Void, Never>?
    @ObservationIgnored private var requestID = UUID()
    @ObservationIgnored private let cache = InspectionCache.standard()
    /// Repository path the current `result` belongs to.
    @ObservationIgnored private var resultPath: String?
    /// Versions exported for previews; private to this user, removed on quit and when switching repositories.
    @ObservationIgnored private var previewRoot: URL?

    init() {
        // Normalize like `select` does (e.g. /private/tmp → /tmp) so a stored path and a reopened one match.
        let stored = UserDefaults.standard.stringArray(forKey: "recentRepositories") ?? []
        recents = RecentRepositories(paths: stored.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
        if recents.paths != stored { UserDefaults.standard.set(recents.paths, forKey: "recentRepositories") }
        cache?.prune(keeping: recents.paths)
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--repository"), args.indices.contains(index + 1) {
            repository = URL(fileURLWithPath: args[index + 1]).standardizedFileURL
        } else if let first = recents.paths.first {
            repository = URL(fileURLWithPath: first)
        }
        if let repository { showCachedResult(for: repository.path) }
        refreshBlockedPushes()
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.removePreviews() }
        }
        // A push is usually blocked in a terminal or an editor; reread the record when coming back.
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshBlockedPushes() }
        }
    }

    func refreshBlockedPushes() {
        let dismissed = (UserDefaults.standard.dictionary(forKey: "dismissedBlockedPushes") as? [String: Date]) ?? [:]
        let latest = BlockedPushes.recent(BlockedPushes.load(), now: Date(), dismissed: dismissed)
        if latest != blockedPushes { blockedPushes = latest }
    }

    /// Hide a blocked repository until its next blocked push.
    func dismissBlockedPush(_ path: String) {
        var dismissed = (UserDefaults.standard.dictionary(forKey: "dismissedBlockedPushes") as? [String: Date]) ?? [:]
        dismissed[path] = Date()
        // Forget hides older than any entry could still be shown.
        dismissed = dismissed.filter { Date().timeIntervalSince($0.value) <= BlockedPushes.maxAge }
        UserDefaults.standard.set(dismissed, forKey: "dismissedBlockedPushes")
        blockedPushes.removeAll { $0.path == path }
    }

    var recentPaths: [String] { recents.paths }

    var visibleRows: [FileRow] {
        rows.filter { (kind == "全部" || $0.kind.rawValue == kind) && (!onlyExceeded || $0.object.exceedsFileLimit) && $0.matches(query) }
    }

    var selectedRow: FileRow? { visibleRows.first { $0.id == selectedFile } }

    @discardableResult func select(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        guard url.isFileURL, FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            error = String(localized: "请选择本机的 Git 仓库文件夹。")
            return false
        }
        var root = url.standardizedFileURL
        while root.path != "/", !FileManager.default.fileExists(atPath: root.appendingPathComponent(".git").path) {
            root.deleteLastPathComponent()
        }
        if root.path == "/" { root = url.standardizedFileURL }
        if root == repository, result != nil || isInspecting { return true }
        repository = root
        removePreviews()
        for dropped in recents.open(root.path) { cache?.remove(path: dropped) }
        saveRecents()
        showCachedResult(for: root.path)
        inspect()
        checkStorage()
        return true
    }

    func forget(_ path: String) {
        recents.remove(path)
        cache?.remove(path: path)
        saveRecents()
    }

    func clearRecents() {
        for path in recents.paths where path != repository?.path { forget(path) }
    }

    private func saveRecents() {
        UserDefaults.standard.set(recents.paths, forKey: "recentRepositories")
    }

    /// Show the last stored report for `path` immediately, or clear the report if there is none.
    private func showCachedResult(for path: String) {
        task?.cancel()
        requestID = UUID()
        isInspecting = false
        error = nil
        copiedJSON = false
        if let cached = cache?.load(path: path) {
            result = cached.result
            rows = cached.result.report.files
            checkedAt = cached.checkedAt
            resultPath = path
            isShowingCache = true
        } else {
            result = nil
            rows = []
            checkedAt = nil
            resultPath = nil
            isShowingCache = false
        }
        selectedFile = nil
    }

    func inspect() {
        guard let repository else { choosingRepository = true; return }
        task?.cancel()
        let id = UUID()
        requestID = id
        let path = repository.path
        // Keep showing this repository's last report (cached or live) while the new run is in progress.
        if resultPath != path {
            result = nil
            rows = []
            selectedFile = nil
            checkedAt = nil
            isShowingCache = false
        }
        error = nil
        copiedJSON = false
        isInspecting = true
        task = Task {
            do {
                let defaults = UserDefaults.standard
                let client = try InspectionClient.bundled(nodeOverride: defaults.string(forKey: "nodePath") ?? "")
                let limits = BudgetSetting.arguments(in: defaults, overriding: defaults.bool(forKey: "overrideLimits"))
                let next = try await client.inspect(repository: repository, limits: limits)
                guard requestID == id else { return }
                let now = Date()
                result = next
                rows = next.report.files
                if let selected = selectedFile, !rows.contains(where: { $0.id == selected }) { selectedFile = nil }
                checkedAt = now
                resultPath = path
                isShowingCache = false
                // A failed cache write only costs the instant view next time; the live report is unaffected.
                try? cache?.store(next, path: path, checkedAt: now)
            } catch is CancellationError {
                // A new selection or explicit cancellation owns the current UI state.
            } catch {
                guard requestID == id else { return }
                self.error = (error as? InspectionFailure)?.localizedDescription
                    ?? String(localized: "检查程序未能运行。请在设置中确认 Node.js 路径，或重新安装应用。")
            }
            if requestID == id { isInspecting = false; task = nil }
        }
    }

    /// The CLI bundled with the app, honouring the Node.js path from Settings.
    func client() throws -> InspectionClient {
        try InspectionClient.bundled(nodeOverride: UserDefaults.standard.string(forKey: "nodePath") ?? "")
    }

    /// Run `yunbox doctor` for the current repository; a newer call or a switch supersedes older ones.
    func checkStorage() {
        guard let repository else { return }
        storageTask?.cancel()
        let id = UUID()
        storageRequestID = id
        if storageReport != nil, storageReportPath != repository.path { storageReport = nil }
        storageError = nil
        isCheckingStorage = true
        storageTask = Task {
            do {
                let report = try await client().doctor(repository: repository)
                guard storageRequestID == id else { return }
                storageReport = report
                storageReportPath = repository.path
            } catch is CancellationError {
            } catch {
                guard storageRequestID == id else { return }
                storageError = (error as? LocalizedError)?.errorDescription ?? String(localized: "检查程序未能运行。请在设置中确认 Node.js 路径。")
            }
            if storageRequestID == id { isCheckingStorage = false; storageTask = nil }
        }
    }

    @ObservationIgnored private var storageReportPath: String?

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

    func change(for row: FileRow) -> InspectionReport.Change? { changeIndex[row.id] }

    /// Reads pushed versions of the current repository with the Git the CLI uses.
    func contentReader() -> ContentReader? {
        guard let repository else { return nil }
        return (try? client())?.contentReader(repository: repository) ?? ContentReader(repository: repository)
    }

    /// Where the version `oid` is exported under the Quick Look title `name`.
    func previewFile(oid: String, name: String) throws -> URL {
        let root = previewRoot ?? FileManager.default.temporaryDirectory.appending(path: "YunBoxPreview-\(UUID().uuidString)", directoryHint: .isDirectory)
        if previewRoot == nil {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            previewRoot = root
        }
        return root.appending(path: oid, directoryHint: .isDirectory).appending(path: name)
    }

    private func removePreviews() {
        if let previewRoot { try? FileManager.default.removeItem(at: previewRoot) }
        previewRoot = nil
    }

    func reveal(_ row: FileRow) {
        guard let repository, let path = row.object.paths.first else { return }
        let file = repository.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(repository.standardizedFileURL.path + "/"), FileManager.default.fileExists(atPath: file.path) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([file])
    }
}
