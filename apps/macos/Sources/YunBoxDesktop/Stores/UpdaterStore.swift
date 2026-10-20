import Foundation
import Observation
import Sparkle

/// Sparkle's updater and the state the menu and settings show.
///
/// The feed, public key and signing policy live in Info.plist (script/build_and_run.sh). Sparkle checks
/// in the background once a day, keeps the user's choices in its own defaults (SUEnableAutomaticChecks,
/// SUAutomaticallyUpdate) and only installs archives whose EdDSA signature matches SUPublicEDKey.
@MainActor @Observable
final class UpdaterStore {
    /// Whether "检查更新…" can run now; false while a check or an install is under way.
    private(set) var canCheckForUpdates = false
    private(set) var lastUpdateCheckDate: Date?
    /// False when the binary runs outside a configured .app (e.g. `swift run`), so updates are unavailable.
    let isAvailable: Bool

    @ObservationIgnored private let controller: SPUStandardUpdaterController
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []

    init(bundle: Bundle = .main) {
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
        isAvailable = bundle.object(forInfoDictionaryKey: "SUFeedURL") != nil
            && bundle.object(forInfoDictionaryKey: "SUPublicEDKey") != nil
        guard isAvailable else { return }
        controller.startUpdater()
        let updater = controller.updater
        canCheckForUpdates = updater.canCheckForUpdates
        lastUpdateCheckDate = updater.lastUpdateCheckDate
        observations = [
            updater.observe(\.canCheckForUpdates, options: [.new]) { [weak self] updater, _ in
                MainActor.assumeIsolated { self?.canCheckForUpdates = updater.canCheckForUpdates }
            },
            updater.observe(\.lastUpdateCheckDate, options: [.new]) { [weak self] updater, _ in
                MainActor.assumeIsolated { self?.lastUpdateCheckDate = updater.lastUpdateCheckDate }
            },
        ]
    }

    /// Check now and show the result, including "已是最新版本".
    func checkForUpdates() {
        guard isAvailable else { return }
        controller.checkForUpdates(nil)
    }

    var automaticallyChecksForUpdates: Bool {
        get { access(keyPath: \.automaticallyChecksForUpdates); return controller.updater.automaticallyChecksForUpdates }
        set { withMutation(keyPath: \.automaticallyChecksForUpdates) { controller.updater.automaticallyChecksForUpdates = newValue } }
    }

    var automaticallyDownloadsUpdates: Bool {
        get { access(keyPath: \.automaticallyDownloadsUpdates); return controller.updater.automaticallyDownloadsUpdates }
        set { withMutation(keyPath: \.automaticallyDownloadsUpdates) { controller.updater.automaticallyDownloadsUpdates = newValue } }
    }

    /// CFBundleShortVersionString, e.g. "0.1.5".
    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? String(localized: "开发版本")
    }
}
