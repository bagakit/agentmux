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

    private func begin(id: Int) {
        DispatchQueue.global().async { [weak self] in
            let result = Result { try NativeSelectionRequest.run() }
            DispatchQueue.main.async {
                guard let self else { return }
                self.completions += 1
                self.current = nil
                switch result {
                case let .success(rectangle):
                    self.emit(["event": "completion", "state": rectangle == nil ? "cancelled" : "confirmed",
                               "rect": rectangle.map(self.rect) as Any? ?? NSNull(), "count": self.completions])
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
            if method == "begin" { begin(id: id); return }
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
                captureLayout(path: path, id: id)
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
        var value: [String: Any] = ["id": id, "ok": true, "completions": completions, "controls": controls(), "toolbar": toolbarFrame()]
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
    private func toolbarFrame() -> [String: Double] {
        guard let view = current, let toolbar = descendants(view).first(where: { $0.identifier?.rawValue == "native-selection-toolbar" }) else { return [:] }
        return rect(toolbar.convert(toolbar.bounds, to: view))
    }
    private func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
    private func point(_ value: Any?) throws -> NSPoint {
        guard let value = value as? [String: Double], let x = value["x"], let y = value["y"], x.isFinite, y.isFinite else { throw PreviewFailure("Invalid event point") }
        return NSPoint(x: x, y: y)
    }

    private func captureLayout(path: String, id: Int) {
        do {
            guard let view = current, let window = view.window, let backdrop = background.contentView else {
                throw PreviewFailure("Original production view is unavailable")
            }
            let crop = background.frame.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY)
            backdrop.displayIfNeeded()
            view.displayIfNeeded()
            guard let base = backdrop.bitmapImageRepForCachingDisplay(in: backdrop.bounds),
                  let overlay = view.bitmapImageRepForCachingDisplay(in: crop) else {
                throw PreviewFailure("AppKit did not create layout bitmap representations")
            }
            backdrop.cacheDisplay(in: backdrop.bounds, to: base)
            view.cacheDisplay(in: crop, to: overlay)
            guard let composite = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: base.pixelsWide, pixelsHigh: base.pixelsHigh,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                  let context = NSGraphicsContext(bitmapImageRep: composite) else { throw PreviewFailure("Layout composite allocation failed") }
            composite.size = backdrop.bounds.size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            base.draw(in: backdrop.bounds)
            overlay.draw(in: backdrop.bounds)
            NSGraphicsContext.restoreGraphicsState()
            guard let data = composite.representation(using: .png, properties: [:]) else { throw PreviewFailure("Layout PNG encoding failed") }
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            emit(["id": id, "ok": true, "width": composite.pixelsWide, "height": composite.pixelsHigh,
                  "source": "AppKit-view-layout-only", "windowServerFrame": false])
        } catch { emit(["id": id, "ok": false, "message": String(describing: error)]) }
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
        let title = "AgentMux · 原生截图选区"
        title.draw(at: NSPoint(x: 64, y: bounds.height - 100), withAttributes: [.font: NSFont.systemFont(ofSize: 25, weight: .semibold), .foregroundColor: NSColor.white])
        "Production AppKit picker · logical points · original capture contract".draw(at: NSPoint(x: 64, y: bounds.height - 132),
            withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.white.withAlphaComponent(0.55)])
    }
}
