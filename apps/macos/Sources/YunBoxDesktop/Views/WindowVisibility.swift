import AppKit
import SwiftUI

extension View {
    /// Calls `action` when the window holding this view comes on screen or goes away. `MenuBarExtra` keeps
    /// its panel's views alive between openings, so `onAppear` / `onDisappear` cannot tell when it opens
    /// and closes; the window's visibility can.
    func onWindowVisibilityChange(_ action: @escaping (Bool) -> Void) -> some View {
        background(WindowVisibility(action: action))
    }
}

private struct WindowVisibility: NSViewRepresentable {
    let action: (Bool) -> Void

    func makeNSView(context: Context) -> Probe {
        let probe = Probe()
        probe.action = action
        return probe
    }

    func updateNSView(_ probe: Probe, context: Context) { probe.action = action }

    final class Probe: NSView {
        var action: ((Bool) -> Void)?
        private var visible = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            NotificationCenter.default.removeObserver(self)
            if let window {
                NotificationCenter.default.addObserver(self, selector: #selector(occlusionChanged),
                                                       name: NSWindow.didChangeOcclusionStateNotification, object: window)
            }
            occlusionChanged()
        }

        @objc private func occlusionChanged() {
            let now = window.map { $0.isVisible && $0.occlusionState.contains(.visible) } ?? false
            guard now != visible else { return }
            visible = now
            action?(now)
        }
    }
}
