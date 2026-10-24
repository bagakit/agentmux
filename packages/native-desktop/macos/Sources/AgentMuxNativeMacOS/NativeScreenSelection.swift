import AppKit
import AgentMuxNativeMacOSCore

struct NativeScreenSelectionError: Error {
    let code: String
    let message: String
}

/// This exact AppKit surface is shared by production capture and the bare
/// preview. Its normal event loop leaves unrelated native queries available.
final class NativeScreenSelection: NSView {
    private static var active: NativeScreenSelection?
    private var selection: NativeSelectionState
    private var overlay: NSWindow?
    private var previousApp: NSRunningApplication?
    private var primaryTop: CGFloat = 0
    private var globalOrigin = NSPoint.zero
    private var screenFrames: [NSRect] = []
    private var completion: ((Result<CGRect?, Error>) -> Void)?
    private let toolbar = NativeSelectionPanel(frame: .zero)
    private let dimensions = NativeSelectionPanel(frame: .zero)
    private let sizeLabel = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: "")
    private let confirmButton = NSButton(title: "截图 ↵", target: nil, action: nil)
    private let cancelButton = NSButton(title: "取消 Esc", target: nil, action: nil)
    override var acceptsFirstResponder: Bool { true }

    override init(frame: NSRect) {
        selection = NativeSelectionState(bounds: NSRect(origin: .zero, size: frame.size))
        super.init(frame: frame)
        buildControls()
    }
    required init?(coder: NSCoder) { nil }

    static func begin(completion: @escaping (Result<CGRect?, Error>) -> Void) throws {
        guard active == nil else { throw NativeScreenSelectionError(code: "capture_busy", message: "the original native selection is still active") }
        guard let primary = NSScreen.screens.first else {
            throw NativeScreenSelectionError(code: "display_unavailable", message: "macOS did not provide an active selection display")
        }
        let allScreens = NSScreen.screens.reduce(NSRect.null) { $0.union($1.frame) }
        let window = NativeSelectionWindow(contentRect: allScreens, styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = false
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let view = NativeScreenSelection(frame: NSRect(origin: .zero, size: allScreens.size))
        view.previousApp = NSWorkspace.shared.frontmostApplication
        view.primaryTop = primary.frame.maxY
        view.globalOrigin = allScreens.origin
        view.screenFrames = NSScreen.screens.map { $0.frame.offsetBy(dx: -allScreens.minX, dy: -allScreens.minY) }
        view.completion = completion
        view.overlay = window
        active = view
        window.contentView = view
        window.makeFirstResponder(view)
        NotificationCenter.default.addObserver(view, selector: #selector(displayConfigurationChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        view.refresh()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func buildControls() {
        toolbar.identifier = NSUserInterfaceItemIdentifier("native-selection-toolbar")
        confirmButton.identifier = NSUserInterfaceItemIdentifier("native-selection-confirm")
        cancelButton.identifier = NSUserInterfaceItemIdentifier("native-selection-cancel")
        confirmButton.setAccessibilityIdentifier("native-selection-confirm")
        cancelButton.setAccessibilityIdentifier("native-selection-cancel")
        for button in [cancelButton, confirmButton] {
            button.target = self
            button.bezelStyle = .rounded
            button.controlSize = .regular
            toolbar.addSubview(button)
        }
        confirmButton.action = #selector(confirm)
        cancelButton.action = #selector(cancel)
        confirmButton.keyEquivalent = "\r"
        cancelButton.keyEquivalent = "\u{1b}"
        confirmButton.toolTip = "确认截图 (Enter)"
        cancelButton.toolTip = "取消截图 (Esc)"
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = .white
        toolbar.addSubview(hint)
        sizeLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        sizeLabel.textColor = .white
        dimensions.addSubview(sizeLabel)
        dimensions.isPassive = true
        addSubview(dimensions)
        addSubview(toolbar)
    }

    @objc private func confirm() {
        guard selection.canConfirm, let rect = selection.rectangle else { return }
        let global = rect.offsetBy(dx: globalOrigin.x, dy: globalOrigin.y)
        finish(.success(NativeCaptureGeometry.quartzRect(appKitRect: global, primaryDisplayTop: primaryTop)))
    }
    @objc private func cancel() { finish(.success(nil)) }
    @objc private func displayConfigurationChanged() {
        finish(.failure(NativeScreenSelectionError(code: "display_configuration_changed", message: "display geometry changed during the original selection; choose the region again")))
    }

    private func finish(_ result: Result<CGRect?, Error>) {
        guard let callback = completion else { return }
        completion = nil
        NotificationCenter.default.removeObserver(self)
        overlay?.orderOut(nil)
        overlay?.close()
        overlay = nil
        Self.active = nil
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier {
            previousApp?.activate(options: [.activateIgnoringOtherApps])
        }
        callback(result)
    }

    private func refresh() {
        confirmButton.isEnabled = selection.canConfirm
        hint.stringValue = selection.rectangle == nil ? "拖动选择区域 · Esc 取消" : "拖动移动 · 边角调整 · 方向键微调"
        let screen = currentScreen()
        let width = min(480, max(0, screen.width - 24))
        let stacked = width < 240
        let height: CGFloat = stacked ? 76 : 40
        var origin = NSPoint(x: screen.midX - width / 2, y: screen.minY + 28)
        if let rect = selection.rectangle {
            origin = NSPoint(x: rect.midX - width / 2, y: rect.minY - height - 12)
            if origin.y < screen.minY + 12 { origin.y = rect.maxY + 12 }
        }
        toolbar.frame = NativeSelectionState.panelFrame(size: CGSize(width: width, height: height), preferredOrigin: origin, screen: screen)
        let actualWidth = toolbar.bounds.width, actualHeight = toolbar.bounds.height
        hint.isHidden = actualWidth < 430
        hint.frame = NSRect(x: 12, y: 12, width: max(0, actualWidth - 210), height: 17)
        if stacked {
            let buttonHeight = min(28, max(0, (actualHeight - 18) / 2))
            cancelButton.frame = NSRect(x: 8, y: 6, width: max(0, actualWidth - 16), height: buttonHeight)
            confirmButton.frame = NSRect(x: 8, y: actualHeight - buttonHeight - 6, width: max(0, actualWidth - 16), height: buttonHeight)
        } else {
            cancelButton.frame = NSRect(x: actualWidth - 190, y: 7, width: 90, height: 28)
            confirmButton.frame = NSRect(x: actualWidth - 94, y: 7, width: 82, height: 28)
        }
        dimensions.isHidden = selection.rectangle == nil
        if let rect = selection.rectangle {
            let dimension: (CGFloat) -> String = { value in
                if value > 0 && value < 0.01 { return "<0.01" }
                return value.rounded() == value ? String(format: "%.0f", Double(value)) : String(format: "%.2f", Double(value))
            }
            sizeLabel.stringValue = "\(dimension(rect.width)) × \(dimension(rect.height)) pt"
            sizeLabel.sizeToFit()
            let size = NSSize(width: sizeLabel.frame.width + 20, height: 28)
            var point = NSPoint(x: rect.minX, y: rect.maxY + 8)
            if point.y + size.height > screen.maxY - 8 { point.y = rect.maxY - size.height - 8 }
            dimensions.frame = NativeSelectionState.panelFrame(size: size, preferredOrigin: point, screen: screen, padding: 8)
            sizeLabel.frame.origin = NSPoint(x: 10, y: 7)
            sizeLabel.frame.size.width = max(0, dimensions.bounds.width - 20)
        }
        window?.invalidateCursorRects(for: self)
        needsDisplay = true
    }

    private func currentScreen() -> CGRect {
        if let rect = selection.rectangle {
            return screenFrames.max { a, b in
                let left = a.intersection(rect), right = b.intersection(rect)
                return (left.isNull ? 0 : left.width * left.height) < (right.isNull ? 0 : right.width * right.height)
            } ?? bounds
        }
        let mouse = NSEvent.mouseLocation
        return screenFrames.first { $0.contains(CGPoint(x: mouse.x - globalOrigin.x, y: mouse.y - globalOrigin.y)) } ?? screenFrames.first ?? bounds
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.28).setFill()
        bounds.fill()
        guard let rect = selection.rectangle else { return }
        NSColor.clear.setFill()
        rect.fill(using: .copy)
        let border = NSBezierPath(rect: rect)
        NSColor.black.withAlphaComponent(0.55).setStroke()
        border.lineWidth = 3
        border.stroke()
        NSColor.white.setStroke()
        border.lineWidth = 1
        border.stroke()
        for handle in NativeSelectionState.Handle.allCases {
            guard let point = selection.point(for: handle) else { continue }
            let dot = NSBezierPath(roundedRect: NSRect(x: point.x - 4, y: point.y - 4, width: 8, height: 8), xRadius: 1.5, yRadius: 1.5)
            NSColor.white.setFill()
            dot.fill()
            NSColor.black.withAlphaComponent(0.6).setStroke()
            dot.lineWidth = 1
            dot.stroke()
        }
    }
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
        if let rect = selection.rectangle { addCursorRect(rect, cursor: .openHand) }
        for handle in NativeSelectionState.Handle.allCases {
            if let point = selection.point(for: handle) {
                let cursor: NSCursor = [.top, .bottom].contains(handle) ? .resizeUpDown : [.left, .right].contains(handle) ? .resizeLeftRight : .crosshair
                addCursorRect(NSRect(x: point.x - 8, y: point.y - 8, width: 16, height: 16), cursor: cursor)
            }
        }
        addCursorRect(toolbar.frame, cursor: .arrow)
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        selection.pointerDown(convert(event.locationInWindow, from: nil))
        refresh()
    }
    override func mouseDragged(with event: NSEvent) { selection.pointerDragged(convert(event.locationInWindow, from: nil)); refresh() }
    override func mouseUp(with event: NSEvent) { selection.pointerUp(convert(event.locationInWindow, from: nil)); refresh() }
    override func keyDown(with event: NSEvent) {
        let step: CGFloat = event.modifierFlags.contains(.shift) ? 10 : 1
        switch event.keyCode {
        case 53: cancel()
        case 36, 76: confirm()
        case 123: selection.nudge(dx: -step, dy: 0); refresh()
        case 124: selection.nudge(dx: step, dy: 0); refresh()
        case 125: selection.nudge(dx: 0, dy: -step); refresh()
        case 126: selection.nudge(dx: 0, dy: step); refresh()
        default: super.keyDown(with: event)
        }
    }
    override func cancelOperation(_ sender: Any?) { cancel() }
}

private final class NativeSelectionPanel: NSView {
    var isPassive = false
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(calibratedWhite: 0.10, alpha: 0.96).cgColor
        layer?.cornerRadius = 9
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.white.withAlphaComponent(0.16).cgColor
        layer?.shadowOpacity = 0.2
        layer?.shadowRadius = 8
    }
    required init?(coder: NSCoder) { nil }
    override func hitTest(_ point: NSPoint) -> NSView? { isPassive ? nil : super.hitTest(point) }
    // Child buttons retain normal AppKit hit testing. Empty toolbar/label
    // events end here instead of bubbling into the parent's selection gesture.
    override func mouseDown(with event: NSEvent) {}
    override func mouseDragged(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) {}
}
private final class NativeSelectionWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
