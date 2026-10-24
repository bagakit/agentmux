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
    private(set) var selection: NativeSelectionState
    private var overlay: NSWindow?
    private var previousApp: NSRunningApplication?
    private var primaryTop: CGFloat = 0
    private var globalOrigin = NSPoint.zero
    private var screenFrames: [NSRect] = []
    private var completion: ((Result<NativeSelectionChoice?, Error>) -> Void)?
    private let allowEditing: Bool
    private let toolbar = NativeSelectionPanel(frame: .zero)
    private let dimensions = NativeSelectionPanel(frame: .zero)
    private let sizeLabel = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: "")
    private let confirmButton = NativeSelectionButton(title: "完成", shortcut: "↵", primary: true)
    private let cancelButton = NativeSelectionButton(title: "取消", shortcut: "esc")
    private let editButton = NativeSelectionButton(title: "标注…", shortcut: "E", symbol: "pencil.tip.crop.circle")
    override var acceptsFirstResponder: Bool { true }

    init(frame: NSRect, allowEditing: Bool = false) {
        selection = NativeSelectionState(bounds: NSRect(origin: .zero, size: frame.size))
        self.allowEditing = allowEditing
        super.init(frame: frame)
        buildControls()
        refresh()
    }
    required init?(coder: NSCoder) { nil }

    static func begin(allowEditing: Bool = false, completion: @escaping (Result<NativeSelectionChoice?, Error>) -> Void) throws {
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
        let view = NativeScreenSelection(frame: NSRect(origin: .zero, size: allScreens.size), allowEditing: allowEditing)
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
        dimensions.identifier = NSUserInterfaceItemIdentifier("native-selection-dimensions")
        confirmButton.identifier = NSUserInterfaceItemIdentifier("native-selection-confirm")
        cancelButton.identifier = NSUserInterfaceItemIdentifier("native-selection-cancel")
        editButton.identifier = NSUserInterfaceItemIdentifier("native-selection-edit")
        confirmButton.setAccessibilityIdentifier("native-selection-confirm")
        cancelButton.setAccessibilityIdentifier("native-selection-cancel")
        editButton.setAccessibilityIdentifier("native-selection-edit")
        for button in [cancelButton, editButton, confirmButton] {
            button.target = self
            if button !== editButton || allowEditing { toolbar.addSubview(button) }
        }
        confirmButton.action = #selector(confirm)
        cancelButton.action = #selector(cancel)
        editButton.action = #selector(edit)
        confirmButton.keyEquivalent = "\r"
        cancelButton.keyEquivalent = "\u{1b}"
        editButton.keyEquivalent = "e"
        editButton.keyEquivalentModifierMask = []
        confirmButton.toolTip = "完成截图 (Enter)"
        cancelButton.toolTip = "取消截图 (Esc)"
        editButton.toolTip = "标注截图 (E)"
        setAccessibilityHelp("拖动选择区域，拖动选区移动，拖动边角调整，方向键微调，Enter 完成，Esc 取消")
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = NSColor.white.withAlphaComponent(0.85)
        hint.alignment = .center
        addSubview(hint)
        sizeLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        sizeLabel.textColor = .white
        dimensions.addSubview(sizeLabel)
        dimensions.isPassive = true
        addSubview(dimensions)
        addSubview(toolbar)
    }

    @objc private func confirm() {
        complete(action: .capture)
    }
    @objc private func edit() {
        guard allowEditing else { return }
        complete(action: .edit)
    }
    private func complete(action: NativeSelectionCompletionAction) {
        guard selection.canConfirm, let rect = selection.rectangle else { return }
        let global = rect.offsetBy(dx: globalOrigin.x, dy: globalOrigin.y)
        finish(.success(NativeSelectionChoice(rectangle: NativeCaptureGeometry.quartzRect(appKitRect: global, primaryDisplayTop: primaryTop), completionAction: action)))
    }
    @objc private func cancel() { finish(.success(nil)) }
    @objc private func displayConfigurationChanged() {
        finish(.failure(NativeScreenSelectionError(code: "display_configuration_changed", message: "display geometry changed during the original selection; choose the region again")))
    }

    private func finish(_ result: Result<NativeSelectionChoice?, Error>) {
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
        editButton.isEnabled = selection.canConfirm
        hint.stringValue = "拖动选择截图区域"
        hint.isHidden = selection.rectangle != nil
        let screen = currentScreen()
        let buttons = allowEditing ? [cancelButton, editButton, confirmButton] : [cancelButton, confirmButton]
        let idealWidth: CGFloat = allowEditing ? 300 : 194
        let width = min(idealWidth, max(0, screen.width - 24))
        let stacked = width < idealWidth
        let height: CGFloat = stacked ? CGFloat(buttons.count) * 38 + 10 : 48
        var origin = NSPoint(x: screen.midX - width / 2, y: screen.minY + 28)
        if let rect = selection.rectangle {
            origin = NSPoint(x: rect.midX - width / 2, y: rect.minY - height - 12)
            if origin.y < screen.minY + 12 { origin.y = rect.maxY + 12 }
        }
        toolbar.frame = NativeSelectionState.panelFrame(size: CGSize(width: width, height: height), preferredOrigin: origin, screen: screen)
        let actualWidth = toolbar.bounds.width, actualHeight = toolbar.bounds.height
        hint.frame = NativeSelectionState.panelFrame(size: CGSize(width: 220, height: 18), preferredOrigin: NSPoint(x: toolbar.frame.midX - 110, y: toolbar.frame.maxY + 12), screen: screen)
        if stacked {
            let buttonHeight = max(0, (actualHeight - 16 - CGFloat(buttons.count - 1) * 6) / CGFloat(buttons.count))
            for (index, button) in buttons.enumerated() {
                button.frame = NSRect(x: 8, y: 8 + CGFloat(buttons.count - index - 1) * (buttonHeight + 6), width: max(0, actualWidth - 16), height: buttonHeight)
            }
        } else {
            cancelButton.frame = NSRect(x: 8, y: 8, width: 84, height: 32)
            if allowEditing { editButton.frame = NSRect(x: 98, y: 8, width: 104, height: 32) }
            confirmButton.frame = NSRect(x: actualWidth - 94, y: 8, width: 86, height: 32)
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
            dimensions.frame = NativeSelectionState.dimensionPanelFrame(size: size, selection: rect, toolbar: toolbar.frame, screen: screen)
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
        case 14 where event.modifierFlags.intersection([.command, .control, .option]).isEmpty: edit()
        case 123: selection.nudge(dx: -step, dy: 0); refresh()
        case 124: selection.nudge(dx: step, dy: 0); refresh()
        case 125: selection.nudge(dx: 0, dy: -step); refresh()
        case 126: selection.nudge(dx: 0, dy: step); refresh()
        default: super.keyDown(with: event)
        }
    }
    override func cancelOperation(_ sender: Any?) { cancel() }
}

/// Presentation only: keep AppKit's button action, keyboard and accessibility
/// contracts while sharing one quiet toolbar treatment for all three actions.
private final class NativeSelectionButton: NSButton {
    private let shortcut: String
    private let primary: Bool
    private let symbol: String?
    private var hovered = false
    private var hoverTracking: NSTrackingArea?
    override var acceptsFirstResponder: Bool { true }

    init(title: String, shortcut: String, primary: Bool = false, symbol: String? = nil) {
        self.shortcut = shortcut
        self.primary = primary
        self.symbol = symbol
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        focusRingType = .none
        setAccessibilityLabel(title)
    }
    required init?(coder: NSCoder) { nil }
    override var isEnabled: Bool { didSet { needsDisplay = true } }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTracking { removeTrackingArea(hoverTracking) }
        let tracking = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(tracking)
        hoverTracking = tracking
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
    override func becomeFirstResponder() -> Bool { let accepted = super.becomeFirstResponder(); needsDisplay = true; return accepted }
    override func resignFirstResponder() -> Bool { let accepted = super.resignFirstResponder(); needsDisplay = true; return accepted }
    override func draw(_ dirtyRect: NSRect) {
        let active = isEnabled && (hovered || isHighlighted)
        let mint = NSColor(calibratedRed: 0.66, green: 0.88, blue: 0.79, alpha: 1)
        let surface = primary ? (isEnabled ? mint.withAlphaComponent(active ? 0.82 : 1) : NSColor.white.withAlphaComponent(0.08)) : NSColor.white.withAlphaComponent(active ? 0.10 : 0)
        surface.setFill()
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
        shape.fill()
        if window?.firstResponder === self {
            mint.setStroke()
            shape.lineWidth = 1.5
            shape.stroke()
        }
        let color = isEnabled ? (primary ? NSColor(calibratedWhite: 0.10, alpha: 1) : .white) : NSColor.white.withAlphaComponent(0.36)
        let font = NSFont.systemFont(ofSize: 12, weight: primary ? .semibold : .medium)
        let keyFont = NSFont.systemFont(ofSize: 10, weight: .medium)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        let keyAttributes: [NSAttributedString.Key: Any] = [.font: keyFont, .foregroundColor: color.withAlphaComponent(isEnabled ? 0.65 : 0.36)]
        let label = title as NSString, key = shortcut as NSString
        let labelSize = label.size(withAttributes: attributes), keySize = key.size(withAttributes: keyAttributes)
        let imageWidth: CGFloat = symbol == nil ? 0 : 18
        let start = max(7, (bounds.width - labelSize.width - keySize.width - 9 - imageWidth) / 2)
        if let symbol, let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
            let configuration = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium).applying(.init(paletteColors: [color]))
            image.withSymbolConfiguration(configuration)?.draw(in: NSRect(x: start, y: (bounds.height - 14) / 2, width: 14, height: 14))
        }
        label.draw(at: NSPoint(x: start + imageWidth, y: (bounds.height - labelSize.height) / 2), withAttributes: attributes)
        key.draw(at: NSPoint(x: start + imageWidth + labelSize.width + 9, y: (bounds.height - keySize.height) / 2), withAttributes: keyAttributes)
    }
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
