import AppKit

/// The YunBox mark (`assets/brand/yunbox-mark.svg`) as a menu bar template image, so it follows the
/// menu bar's light, dark and tinted appearances. `lid` tips the lid open on its left hinge (0 shut,
/// 1 open, a little past either end while it springs); `badge` scales a dot, cut out from the mark,
/// shown while pushes are frozen.
@MainActor
enum MenuBarIcon {
    private static let plain = make(lid: 0, badge: 0)
    private static let badged = make(lid: 0, badge: 1)
    private static let open = make(lid: 1, badge: 0)
    private static let openBadged = make(lid: 1, badge: 1)

    static func image(lid: CGFloat = 0, badge: CGFloat) -> NSImage {
        switch (lid, badge) {
        case (0, 0): plain
        case (0, 1): badged
        case (1, 0): open
        case (1, 1): openBadged
        // Frames in between are drawn once each, while the animation runs.
        default: make(lid: lid, badge: badge)
        }
    }

    private static func make(lid: CGFloat, badge: CGFloat) -> NSImage {
        // Taller than the mark so the opening lid has room above it; the menu bar centres the image, so
        // the shut mark sits where it always has.
        let image = NSImage(size: NSSize(width: 18, height: 20), flipped: true) { rect in
            draw(in: rect, lid: lid, badge: badge)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = badge > 0 ? String(localized: "云匣：处于禁推时段") : String(localized: "云匣")
        return image
    }

    private static func draw(in rect: NSRect, lid: CGFloat, badge: CGFloat) {
        // The mark spans x 8…56 and y 13…53 of its 64-point view box.
        let scale = min(rect.width / 48, rect.height / 40)
        let origin = NSPoint(x: rect.midX - 24 * scale, y: rect.midY - 20 * scale)
        func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: origin.x + (x - 8) * scale, y: origin.y + (y - 13) * scale)
        }
        func box(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> NSRect {
            NSRect(origin: point(x, y), size: NSSize(width: width * scale, height: height * scale))
        }
        NSColor.black.setFill()
        let lidPath = NSBezierPath(rect: box(8, 13, 48, 8))
        if lid != 0 {
            // Lift a little and turn about the bottom-left corner; fully open, the right end clears the
            // body by about 2 points and stays inside the image.
            let hinge = point(8, 21)
            var turn = AffineTransform(translationByX: hinge.x, byY: hinge.y - lid * scale)
            turn.rotate(byDegrees: -6 * lid)
            turn.translate(x: -hinge.x, y: -hinge.y)
            lidPath.transform(using: turn)
        }
        lidPath.fill()
        let body = NSBezierPath(rect: box(11, 25, 42, 28))
        body.move(to: point(22.6, 33.6))
        body.line(to: point(28.6, 44))
        body.line(to: point(16.6, 44))
        body.close()
        body.appendOval(in: box(36, 33.4, 11.2, 11.2))
        body.windingRule = .evenOdd
        body.fill()
        guard badge > 0.01 else { return }
        // Top right of the mark, like a notification dot; the view is flipped, so smaller y is higher.
        let center = NSPoint(x: rect.maxX - 3.4, y: point(8, 13).y - 0.5 + 3.4)
        func dot(_ radius: CGFloat) -> NSBezierPath {
            let r = radius * badge
            return NSBezierPath(ovalIn: NSRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r))
        }
        NSGraphicsContext.current?.compositingOperation = .clear
        dot(4.6).fill()
        NSGraphicsContext.current?.compositingOperation = .sourceOver
        dot(3.2).fill()
    }
}

/// Plays the menu bar icon's lid and badge: the lid springs open while the panel is showing and drops
/// shut when it closes, and the badge pops in when a push freeze starts. With Reduce Motion on, both
/// jump straight to where they end up.
@MainActor @Observable
final class MenuBarIconAnimator {
    private(set) var lid: CGFloat = 0
    private(set) var badge: CGFloat = 0
    @ObservationIgnored private var lidTask: Task<Void, Never>?
    @ObservationIgnored private var badgeTask: Task<Void, Never>?

    var image: NSImage { MenuBarIcon.image(lid: lid, badge: badge) }

    func setOpen(_ open: Bool) {
        lidTask?.cancel()
        lidTask = animate(\.lid, to: open ? 1 : 0, duration: open ? 0.3 : 0.26, curve: Self.backOut)
    }

    func setBadge(_ shown: Bool) {
        badgeTask?.cancel()
        badgeTask = shown
            ? animate(\.badge, to: 1, duration: 0.32, curve: Self.backOut)
            : animate(\.badge, to: 0, duration: 0.16) { $0 * $0 }
    }

    private func animate(_ value: ReferenceWritableKeyPath<MenuBarIconAnimator, CGFloat>, to target: CGFloat,
                         duration: Double, curve: @escaping (Double) -> Double) -> Task<Void, Never>? {
        let start = self[keyPath: value]
        guard start != target else { return nil }
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            self[keyPath: value] = target
            return nil
        }
        return Task { [weak self] in
            let clock = ContinuousClock()
            let began = clock.now
            while true {
                do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
                guard let self else { return }
                let elapsed = began.duration(to: clock.now)
                let t = min(1, (Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18) / duration)
                self[keyPath: value] = t < 1 ? start + (target - start) * curve(t) : target
                if t >= 1 { return }
            }
        }
    }

    /// Ease out past the end by about a tenth, then settle: the lid bounces open, and shut it lands
    /// just past closed before resting.
    private static func backOut(_ t: Double) -> Double {
        let c1 = 1.70158, c3 = c1 + 1
        return 1 + c3 * pow(t - 1, 3) + c1 * pow(t - 1, 2)
    }
}
