import AppKit

/// The YunBox mark (`assets/brand/yunbox-mark.svg`) as a menu bar template image, so it follows the
/// menu bar's light, dark and tinted appearances. `badge` adds a dot, cut out from the mark, while
/// pushes are frozen.
@MainActor
enum MenuBarIcon {
    private static let plain = make(badge: false)
    private static let badged = make(badge: true)

    static func image(badge: Bool) -> NSImage { badge ? badged : plain }

    private static func make(badge: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 16), flipped: true) { rect in
            draw(in: rect, badge: badge)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = badge ? String(localized: "云匣：处于禁推时段") : String(localized: "云匣")
        return image
    }

    private static func draw(in rect: NSRect, badge: Bool) {
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
        NSBezierPath(rect: box(8, 13, 48, 8)).fill()
        let body = NSBezierPath(rect: box(11, 25, 42, 28))
        body.move(to: point(22.6, 33.6))
        body.line(to: point(28.6, 44))
        body.line(to: point(16.6, 44))
        body.close()
        body.appendOval(in: box(36, 33.4, 11.2, 11.2))
        body.windingRule = .evenOdd
        body.fill()
        guard badge else { return }
        // Top right, like a notification dot; the view is flipped, so minY is the top edge.
        let center = NSPoint(x: rect.maxX - 3.4, y: rect.minY + 3.4)
        NSGraphicsContext.current?.compositingOperation = .clear
        NSBezierPath(ovalIn: NSRect(x: center.x - 4.6, y: center.y - 4.6, width: 9.2, height: 9.2)).fill()
        NSGraphicsContext.current?.compositingOperation = .sourceOver
        NSBezierPath(ovalIn: NSRect(x: center.x - 3.2, y: center.y - 3.2, width: 6.4, height: 6.4)).fill()
    }
}
