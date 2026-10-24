import AppKit
import AgentMuxNativeMacOSCore

struct NativeScreenSelectionError: Error {
    let code: String
    let message: String
}

/// Each display has its own AppKit window. All canvases project one original
/// request's global AppKit selection and route events to that same coordinator.
final class NativeScreenSelection: NSView {
    private struct Presentation {
        let coordinator: NativeSelectionCoordinator
        let windows: [NSWindow]
    }
    private static var active: Presentation?
    private let coordinator: NativeSelectionCoordinator
    let viewport: NSRect
    var selection: NativeSelectionState { coordinator.selection }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init(frame: NSRect, allowEditing: Bool = false) {
        viewport = frame
        coordinator = NativeSelectionCoordinator(screenFrames: [frame], primaryTop: frame.maxY,
            initialPoint: NSPoint(x: frame.midX, y: frame.midY), allowEditing: allowEditing)
        super.init(frame: frame)
        coordinator.register(self)
    }
    private init(viewport: NSRect, coordinator: NativeSelectionCoordinator) {
        self.viewport = viewport
        self.coordinator = coordinator
        super.init(frame: NSRect(origin: .zero, size: viewport.size))
        coordinator.register(self)
    }
    required init?(coder: NSCoder) { nil }

    static func begin(allowEditing: Bool = false, completion: @escaping (Result<NativeSelectionChoice?, Error>) -> Void) throws {
        guard active == nil else { throw NativeScreenSelectionError(code: "capture_busy", message: "the original native selection is still active") }
        let screens = NSScreen.screens
        guard let primary = screens.first else {
            throw NativeScreenSelectionError(code: "display_unavailable", message: "macOS did not provide an active selection display")
        }
        let coordinator = NativeSelectionCoordinator(screenFrames: screens.map(\.frame), primaryTop: primary.frame.maxY,
            initialPoint: NSEvent.mouseLocation, allowEditing: allowEditing, previousApp: NSWorkspace.shared.frontmostApplication,
            completion: completion)
        var windows: [NSWindow] = []
        for screen in screens {
            let window = NativeSelectionWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.backgroundColor = .clear
            window.isOpaque = false
            window.hasShadow = false
            window.level = .screenSaver
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.contentView = NativeScreenSelection(viewport: screen.frame, coordinator: coordinator)
            window.makeFirstResponder(window.contentView)
            windows.append(window)
        }
        active = Presentation(coordinator: coordinator, windows: windows)
        NotificationCenter.default.addObserver(coordinator, selector: #selector(NativeSelectionCoordinator.displayConfigurationChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
        coordinator.refresh()
        for window in windows { window.orderFront(nil) }
        NSApp.activate(ignoringOtherApps: true)
        let keyboardWindow = windows.first { $0.frame.contains(coordinator.initialPoint) } ?? windows.first
        keyboardWindow?.makeKeyAndOrderFront(nil)
    }

    fileprivate static func closePresentation(for coordinator: NativeSelectionCoordinator) {
        guard let presentation = active, presentation.coordinator === coordinator else { return }
        for window in presentation.windows {
            window.orderOut(nil)
            window.close()
        }
        active = nil
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.28).setFill()
        bounds.fill()
        guard let global = selection.rectangle else { return }
        let rect = global.offsetBy(dx: -viewport.minX, dy: -viewport.minY)
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
            guard let globalPoint = selection.point(for: handle) else { continue }
            let point = NSPoint(x: globalPoint.x - viewport.minX, y: globalPoint.y - viewport.minY)
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
        if let rect = selection.rectangle {
            let visible = rect.offsetBy(dx: -viewport.minX, dy: -viewport.minY).intersection(bounds)
            if !visible.isNull && !visible.isEmpty { addCursorRect(visible, cursor: .openHand) }
        }
        for handle in NativeSelectionState.Handle.allCases {
            if let global = selection.point(for: handle) {
                let point = NSPoint(x: global.x - viewport.minX, y: global.y - viewport.minY)
                let visible = NSRect(x: point.x - 8, y: point.y - 8, width: 16, height: 16).intersection(bounds)
                if !visible.isNull && !visible.isEmpty {
                    let cursor: NSCursor = [.top, .bottom].contains(handle) ? .resizeUpDown : [.left, .right].contains(handle) ? .resizeLeftRight : .crosshair
                    addCursorRect(visible, cursor: cursor)
                }
            }
        }
        if let frame = coordinator.toolbarFrame(in: self) { addCursorRect(frame, cursor: .arrow) }
    }

    private func globalPoint(_ event: NSEvent) -> NSPoint {
        // A drag continues to arrive at its original down view even outside
        // that window. A nil-window mouse event already uses screen coordinates.
        event.window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        coordinator.pointerDown(globalPoint(event))
    }
    override func mouseDragged(with event: NSEvent) { coordinator.pointerDragged(globalPoint(event)) }
    override func mouseUp(with event: NSEvent) { coordinator.pointerUp(globalPoint(event)) }
    override func keyDown(with event: NSEvent) {
        if !coordinator.handleKey(event) { super.keyDown(with: event) }
    }
    override func cancelOperation(_ sender: Any?) { coordinator.cancel() }
}

/// Request-level UI state only. Windows/canvases do not create another selection
/// or completion. Weak canvas references avoid a controller/window/view cycle.
@MainActor
fileprivate final class NativeSelectionCoordinator: NSObject {
    private(set) var selection: NativeSelectionState
    let initialPoint: NSPoint
    private var preferredPoint: NSPoint
    private let primaryTop: CGFloat
    private let screenFrames: [NSRect]
    private let allowEditing: Bool
    private let previousApp: NSRunningApplication?
    private var completion: ((Result<NativeSelectionChoice?, Error>) -> Void)?
    private let views = NSHashTable<NativeScreenSelection>.weakObjects()
    private var controlsViewport: NSRect?
    private let toolbar = NativeSelectionPanel(frame: .zero)
    private let dimensions = NativeSelectionPanel(frame: .zero)
    private let sizeLabel = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: "")
    private let confirmButton = NativeSelectionButton(title: "完成", shortcut: "↵", primary: true)
    private let cancelButton = NativeSelectionButton(title: "取消", shortcut: "esc")
    private let editButton = NativeSelectionButton(title: "标注…", shortcut: "E", symbol: "pencil.tip.crop.circle")

    init(screenFrames: [NSRect], primaryTop: CGFloat, initialPoint: NSPoint, allowEditing: Bool,
         previousApp: NSRunningApplication? = nil, completion: ((Result<NativeSelectionChoice?, Error>) -> Void)? = nil) {
        self.screenFrames = screenFrames
        self.primaryTop = primaryTop
        self.initialPoint = initialPoint
        preferredPoint = initialPoint
        self.allowEditing = allowEditing
        self.previousApp = previousApp
        self.completion = completion
        selection = NativeSelectionState(bounds: screenFrames.reduce(NSRect.null) { $0.union($1) })
        super.init()
        buildControls()
    }
    func register(_ view: NativeScreenSelection) {
        views.add(view)
        view.setAccessibilityHelp("拖动选择区域，拖动选区移动，拖动边角调整，方向键微调，Enter 完成，Esc 取消")
        refresh()
    }
    func toolbarFrame(in view: NativeScreenSelection) -> NSRect? { toolbar.superview === view ? toolbar.frame : nil }

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
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = NSColor.white.withAlphaComponent(0.85)
        hint.alignment = .center
        sizeLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        sizeLabel.textColor = .white
        dimensions.addSubview(sizeLabel)
        dimensions.isPassive = true
    }
    @objc private func confirm() { complete(action: .capture) }
    @objc private func edit() {
        guard allowEditing else { return }
        complete(action: .edit)
    }
    private func complete(action: NativeSelectionCompletionAction) {
        guard selection.canConfirm, let rect = selection.rectangle else { return }
        finish(.success(NativeSelectionChoice(rectangle: NativeCaptureGeometry.quartzRect(appKitRect: rect, primaryDisplayTop: primaryTop), completionAction: action)))
    }
    @objc fileprivate func cancel() { finish(.success(nil)) }
    @objc fileprivate func displayConfigurationChanged() {
        finish(.failure(NativeScreenSelectionError(code: "display_configuration_changed", message: "display geometry changed during the original selection; choose the region again")))
    }
    private func finish(_ result: Result<NativeSelectionChoice?, Error>) {
        guard let callback = completion else { return }
        completion = nil
        NotificationCenter.default.removeObserver(self)
        NativeScreenSelection.closePresentation(for: self)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier {
            previousApp?.activate(options: [.activateIgnoringOtherApps])
        }
        callback(result)
    }

    func pointerDown(_ point: NSPoint) { preferredPoint = point; selection.pointerDown(point); refresh() }
    func pointerDragged(_ point: NSPoint) { selection.pointerDragged(point); refresh() }
    func pointerUp(_ point: NSPoint) { selection.pointerUp(point); refresh() }
    func handleKey(_ event: NSEvent) -> Bool {
        let step: CGFloat = event.modifierFlags.contains(.shift) ? 10 : 1
        switch event.keyCode {
        case 53: cancel()
        case 36, 76: confirm()
        case 14 where event.modifierFlags.intersection([.command, .control, .option]).isEmpty: edit()
        case 123: selection.nudge(dx: -step, dy: 0); refresh()
        case 124: selection.nudge(dx: step, dy: 0); refresh()
        case 125: selection.nudge(dx: 0, dy: -step); refresh()
        case 126: selection.nudge(dx: 0, dy: step); refresh()
        default: return false
        }
        return true
    }

    func refresh() {
        confirmButton.isEnabled = selection.canConfirm
        editButton.isEnabled = selection.canConfirm
        hint.stringValue = "拖动选择截图区域"
        hint.isHidden = selection.rectangle != nil
        let globalScreen = currentScreen()
        guard let host = views.allObjects.first(where: { $0.viewport == globalScreen }) else { return }
        if toolbar.superview !== host {
            hint.removeFromSuperview()
            dimensions.removeFromSuperview()
            toolbar.removeFromSuperview()
            host.addSubview(hint)
            host.addSubview(dimensions)
            host.addSubview(toolbar)
        }
        controlsViewport = globalScreen
        let screen = NSRect(origin: .zero, size: globalScreen.size)
        let localRectangle = selection.rectangle?.offsetBy(dx: -globalScreen.minX, dy: -globalScreen.minY)
        let buttons = allowEditing ? [cancelButton, editButton, confirmButton] : [cancelButton, confirmButton]
        let idealWidth: CGFloat = allowEditing ? 300 : 194
        let width = min(idealWidth, max(0, screen.width - 24))
        let stacked = width < idealWidth
        let height: CGFloat = stacked ? CGFloat(buttons.count) * 38 + 10 : 48
        var origin = NSPoint(x: screen.midX - width / 2, y: screen.minY + 28)
        if let rect = localRectangle {
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
        if let rect = localRectangle {
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
        for view in views.allObjects {
            view.window?.invalidateCursorRects(for: view)
            view.needsDisplay = true
        }
    }
    private func currentScreen() -> CGRect {
        if let rect = selection.rectangle {
            let areas = screenFrames.map { screen -> CGFloat in
                let intersection = screen.intersection(rect)
                return intersection.isNull ? 0 : intersection.width * intersection.height
            }
            if let maximum = areas.max(), maximum > 0 {
                if let controlsViewport, let index = screenFrames.firstIndex(of: controlsViewport), areas[index] == maximum { return controlsViewport }
                if let index = areas.firstIndex(of: maximum) { return screenFrames[index] }
            }
            if let controlsViewport { return controlsViewport }
        }
        return screenFrames.first { $0.contains(preferredPoint) } ?? screenFrames.first ?? selection.bounds
    }
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
