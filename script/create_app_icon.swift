import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let icon = NSImage(size: NSSize(width: 1024, height: 1024))
icon.lockFocus()
let shape = NSBezierPath(roundedRect: NSRect(x: 48, y: 48, width: 928, height: 928), xRadius: 200, yRadius: 200)
NSGradient(starting: NSColor(red: 0.18, green: 0.66, blue: 0.92, alpha: 1), ending: NSColor(red: 0.16, green: 0.33, blue: 0.78, alpha: 1))!.draw(in: shape, angle: -70)
let symbol = NSImage(systemSymbolName: "shippingbox.fill", accessibilityDescription: "YunBox")!
    .withSymbolConfiguration(.init(paletteColors: [.white]))!
symbol.draw(in: NSRect(x: 224, y: 242, width: 576, height: 548))
icon.unlockFocus()
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        icon.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
