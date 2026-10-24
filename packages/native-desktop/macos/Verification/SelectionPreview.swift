import AppKit
import AgentMuxNativeMacOSCore

/// A bare AppKit host for the production picker. Commands deliver events to
/// the actual NSWindow or press actual NSButtons; there is no replacement UI.
@main
@MainActor
private final class SelectionPreview: NSObject, NSApplicationDelegate {
    private var background: NSWindow!
    private var completions = 0
    private var current: NativeScreenSelection?
    private var savedApplication: NSRunningApplication?

    static func main() {
        UnixSocketPathSafety.initializePrivateCreationMask()
        let application = NSApplication.shared
        let host = SelectionPreview()
        host.savedApplication = NSWorkspace.shared.frontmostApplication
        application.setActivationPolicy(.regular)
        application.delegate = host
        application.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.screens.first else { emit(["event": "failed", "message": "No display"]); NSApp.terminate(nil); return }
        background = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        background.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue - 1)
        background.isReleasedWhenClosed = false
        background.contentView = PreviewBackground(frame: NSRect(origin: .zero, size: screen.frame.size))
        background.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.global().async { [weak self] in
            while let line = readLine() {
                guard line.utf8.count < 65536 else { continue }
                DispatchQueue.main.async {
                    guard let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                    self?.command(command)
                }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        let displayID = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
        emit(["event": "ready", "pid": Int(getpid()), "screen": rect(screen.frame), "displayId": displayID])
        if CommandLine.arguments.contains("--interactive") { begin(id: 0) }
    }

    private func begin(id: Int, allowEditing: Bool = false) {
        DispatchQueue.global().async { [weak self] in
            let result = Result { try NativeSelectionRequest.run(allowEditing: allowEditing) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.completions += 1
                self.current = nil
                switch result {
                case let .success(choice):
                    var receipt: [String: Any] = ["event": "completion", "state": choice == nil ? "cancelled" : "confirmed",
                               "rect": choice.map { self.rect($0.rectangle) } as Any? ?? NSNull(), "count": self.completions]
                    if allowEditing, let choice { receipt["completionAction"] = choice.completionAction.rawValue }
                    self.emit(receipt)
                case let .failure(error):
                    self.emit(["event": "completion", "state": "failed", "message": String(describing: error), "count": self.completions])
                }
                if CommandLine.arguments.contains("--interactive") { NSApp.terminate(nil) }
            }
        }
        discoverPicker(id: id, attempts: 100)
    }

    private func discoverPicker(id: Int, attempts: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { [self] in
            let views = NSApp.windows.filter { $0.isVisible }.compactMap { $0.contentView as? NativeScreenSelection }
            guard views.count == 1, let view = views.first else {
                if attempts > 0 { discoverPicker(id: id, attempts: attempts - 1) }
                else { emit(["id": id, "ok": false, "message": "Production picker window is not unique"]) }
                return
            }
            current = view
            emit(["id": id, "ok": true, "window": rect(view.window!.frame), "windowId": view.window!.windowNumber,
                  "pid": Int(getpid()), "completions": completions])
        }
    }

    private func command(_ value: [String: Any]) {
        let id = value["id"] as? Int ?? -1
        do {
            let method = value["method"] as? String ?? ""
            if method == "begin" { begin(id: id, allowEditing: value["allowEditing"] as? Bool == true); return }
            if method == "close" { emit(["id": id, "ok": true]); NSApp.terminate(nil); return }
            if method == "inspect" { emit(observation(id: id)); return }
            guard let view = current, let window = view.window else { throw PreviewFailure("Original picker is unavailable") }
            if method == "drag" {
                let from = try point(value["from"]), to = try point(value["to"])
                guard let recipient = view.hitTest(view.convert(from, from: nil)) else { throw PreviewFailure("No actual AppKit hit-test recipient") }
                for (type, point) in [(NSEvent.EventType.leftMouseDown, from), (.leftMouseDragged, to), (.leftMouseUp, to)] {
                    guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                       windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1) else { throw PreviewFailure("Could not create mouse event") }
                    // Deliberately direct AppKit responder dispatch. The bare
                    // host does not claim WindowServer activation/input proof.
                    switch type {
                    case .leftMouseDown: recipient.mouseDown(with: event)
                    case .leftMouseDragged: recipient.mouseDragged(with: event)
                    default: recipient.mouseUp(with: event)
                    }
                }
            } else if method == "key" {
                let code = value["keyCode"] as? UInt16 ?? 0
                let flags: NSEvent.ModifierFlags = value["shift"] as? Bool == true ? .shift : []
                guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                                                 timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                                 context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: code) else { throw PreviewFailure("Could not create key event") }
                guard let recipient = window.firstResponder else { throw PreviewFailure("Original window has no first responder") }
                recipient.keyDown(with: event)
            } else if method == "button" {
                let identifier = value["identifier"] as? String ?? ""
                guard let button = descendants(view).compactMap({ $0 as? NSButton }).first(where: { $0.identifier?.rawValue == identifier }) else { throw PreviewFailure("Exact button is unavailable") }
                // AppKit's button action/enablement is real. This deliberately
                // does not claim a physical WindowServer mouse click.
                button.performClick(nil)
            } else if method == "layout" {
                guard let path = value["path"] as? String else { throw PreviewFailure("Missing capture output") }
                var size: NSSize?
                if let width = value["width"] as? Double, let height = value["height"] as? Double {
                    guard width.isFinite, height.isFinite, width >= 160, height >= 160, width <= 4096, height <= 4096 else { throw PreviewFailure("Invalid bounded layout viewport") }
                    size = NSSize(width: width, height: height)
                }
                captureLayout(path: path, id: id, constrainedSize: size)
                return
            } else { throw PreviewFailure("Unknown fixture command") }
            emit(observation(id: id))
        } catch { emit(["id": id, "ok": false, "message": String(describing: error)]) }
    }

    private func controls() -> [[String: Any]] {
        guard let view = current else { return [] }
        return descendants(view).compactMap { child in
            guard let button = child as? NSButton, let identifier = button.identifier?.rawValue else { return nil }
            return ["identifier": identifier, "enabled": button.isEnabled, "frame": rect(button.convert(button.bounds, to: view))]
        }
    }
    private func observation(id: Int) -> [String: Any] {
        var value: [String: Any] = ["id": id, "ok": true, "completions": completions, "controls": controls(),
                                  "toolbar": panelFrame("native-selection-toolbar"), "dimensions": panelFrame("native-selection-dimensions")]
        if let view = current {
            value["rectangle"] = view.selection.rectangle.map(rect) as Any? ?? NSNull()
            value["isInteracting"] = view.selection.isInteracting
            value["canConfirm"] = view.selection.canConfirm
            value["window"] = view.window.map { rect($0.frame) } as Any? ?? NSNull()
            value["isKeyWindow"] = view.window?.isKeyWindow ?? false
            value["eventDelivery"] = "direct-AppKit-responder-dispatch"
            value["firstResponder"] = view.window?.firstResponder.map { String(describing: type(of: $0)) } as Any? ?? NSNull()
            value["windowId"] = view.window?.windowNumber ?? 0
            value["pid"] = Int(getpid())
        }
        return value
    }
    private func panelFrame(_ identifier: String) -> [String: Double] {
        guard let view = current, let panel = descendants(view).first(where: { $0.identifier?.rawValue == identifier }), !panel.isHidden else { return [:] }
        return rect(panel.convert(panel.bounds, to: view))
    }
    private func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
    private func point(_ value: Any?) throws -> NSPoint {
        guard let value = value as? [String: Double], let x = value["x"], let y = value["y"], x.isFinite, y.isFinite else { throw PreviewFailure("Invalid event point") }
        return NSPoint(x: x, y: y)
    }

    private func captureLayout(path: String, id: Int, constrainedSize: NSSize? = nil) {
        do {
            var constrainedWindow: NSWindow?
            if let size = constrainedSize {
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: .borderless, backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                let view = NativeScreenSelection(frame: NSRect(origin: .zero, size: size), allowEditing: true)
                window.contentView = view
                for (type, point) in [(NSEvent.EventType.leftMouseDown, NSPoint(x: 24, y: size.height * 0.52)), (.leftMouseUp, NSPoint(x: size.width - 24, y: size.height - 44))] {
                    guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1) else { throw PreviewFailure("Could not create constrained layout event") }
                    if type == .leftMouseDown { view.mouseDown(with: event) } else { view.mouseUp(with: event) }
                }
                constrainedWindow = window
            }
            defer { constrainedWindow?.close() }
            guard let view = constrainedWindow?.contentView as? NativeScreenSelection ?? current,
                  let window = view.window, let backgroundView = background.contentView else {
                throw PreviewFailure("Original production view is unavailable")
            }
            let backdrop = constrainedSize.map { PreviewBackground(frame: NSRect(origin: .zero, size: $0)) } ?? backgroundView
            let crop = constrainedSize == nil ? background.frame.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY) : view.bounds
            backdrop.displayIfNeeded()
            view.displayIfNeeded()
            // A non-key bare window may cache only its layer-backed controls.
            // Explicitly execute the real background/root view draw methods;
            // use AppKit caches only for the actual child controls.
            let children: [(NSImage, NSRect)] = try view.subviews.filter { !$0.isHidden }.map { child in
                guard let bitmap = child.bitmapImageRepForCachingDisplay(in: child.bounds) else {
                    throw PreviewFailure("AppKit did not create a control bitmap representation")
                }
                child.cacheDisplay(in: child.bounds, to: bitmap)
                let image = NSImage(size: child.bounds.size)
                image.addRepresentation(bitmap)
                return (image, child.frame)
            }
            let base = try raster(size: backdrop.bounds.size) { backdrop.draw(backdrop.bounds) }
            let overlay = try raster(size: crop.size) {
                NSGraphicsContext.current?.cgContext.translateBy(x: -crop.minX, y: -crop.minY)
                view.draw(crop)
                for (image, frame) in children { image.draw(in: frame, from: .zero, operation: .sourceOver, fraction: 1) }
            }
            let composite = try raster(size: backdrop.bounds.size) {
                for bitmap in [base, overlay] {
                    let image = NSImage(size: backdrop.bounds.size)
                    image.addRepresentation(bitmap)
                    image.draw(in: backdrop.bounds, from: .zero, operation: .sourceOver, fraction: 1)
                }
            }
            guard let data = composite.representation(using: .png, properties: [:]) else { throw PreviewFailure("Layout PNG encoding failed") }
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            emit(["id": id, "ok": true, "width": composite.pixelsWide, "height": composite.pixelsHigh,
                  "source": "AppKit-view-layout-only", "windowServerFrame": false,
                  "rasterization": "actual-root-draw-and-cached-controls", "compositing": "source-over", "scale": 1,
                  "constrainedViewport": constrainedSize != nil])
        } catch { emit(["id": id, "ok": false, "message": String(describing: error)]) }
    }

    private func raster(size: NSSize, draw: () -> Void) throws -> NSBitmapImageRep {
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(ceil(size.width)), pixelsHigh: Int(ceil(size.height)),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
            throw PreviewFailure("Layout bitmap allocation failed")
        }
        bitmap.size = size
        guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw PreviewFailure("Layout bitmap context failed") }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = context
        context.cgContext.clear(CGRect(origin: .zero, size: size))
        draw()
        context.flushGraphics()
        return bitmap
    }

    func applicationWillTerminate(_ notification: Notification) {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() { savedApplication?.activate(options: [.activateIgnoringOtherApps]) }
    }
    private func rect(_ value: CGRect) -> [String: Double] { ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height] }
    private func emit(_ value: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        data.append(10)
        FileHandle.standardOutput.write(data)
    }
    private struct PreviewFailure: Error { let message: String; init(_ message: String) { self.message = message } }
}

private final class PreviewBackground: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.13, green: 0.19, blue: 0.29, alpha: 1).setFill()
        bounds.fill()
        NSColor.white.withAlphaComponent(0.07).setStroke()
        let grid = NSBezierPath()
        for x in stride(from: CGFloat(0), through: bounds.width, by: 48) { grid.move(to: NSPoint(x: x, y: 0)); grid.line(to: NSPoint(x: x, y: bounds.height)) }
        for y in stride(from: CGFloat(0), through: bounds.height, by: 48) { grid.move(to: NSPoint(x: 0, y: y)); grid.line(to: NSPoint(x: bounds.width, y: y)) }
        grid.stroke()
        if bounds.width < 600 { return }
        let title = "AgentMux · 原生截图选区"
        title.draw(at: NSPoint(x: 64, y: bounds.height - 100), withAttributes: [.font: NSFont.systemFont(ofSize: 25, weight: .semibold), .foregroundColor: NSColor.white])
        "Production AppKit picker · logical points · original capture contract".draw(at: NSPoint(x: 64, y: bounds.height - 132),
            withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.white.withAlphaComponent(0.55)])
    }
}
