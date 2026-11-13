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
    private var motionTracking: NSTrackingArea?
    var selection: NativeSelectionState { coordinator.selection }
    var frozenPixels: NativeSelectionPixels? { coordinator.pixels }
    var pointerLocation: NSPoint { coordinator.pointerLocation }
    var loadingPixels: Bool { coordinator.pixels == nil }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init(frame: NSRect, allowEditing: Bool = false, pixels: NativeSelectionPixels? = nil) {
        viewport = frame
        coordinator = NativeSelectionCoordinator(screenFrames: [frame], primaryTop: frame.maxY,
            initialPoint: NSPoint(x: frame.midX, y: frame.midY), allowEditing: allowEditing, pixels: pixels)
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

    static func begin(allowEditing: Bool = false,
        load: @escaping @Sendable (NativeSelectionLoading) throws -> NativeSelectionPixels,
        completion: @escaping (Result<NativeSelectionChoice?, Error>) -> Void) throws {
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
            window.acceptsMouseMovedEvents = true
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
        let loading = coordinator.loading
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try load(loading) }
            DispatchQueue.main.async { coordinator.loaded(result) }
        }
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
        let frozen = coordinator.pixels?.display(in: viewport)
        if let image = frozen?.image {
            NSImage(cgImage: image, size: bounds.size).draw(in: bounds)
        } else if let issue = frozen?.issue {
            NSColor(calibratedWhite: 0.09, alpha: 1).setFill()
            bounds.fill()
            let text = "此屏幕暂时无法采图\n\(issue)\n\n其他可用屏幕仍可选择 · Esc 取消"
            text.draw(in: NSRect(x: 28, y: bounds.midY - 60, width: max(1, bounds.width - 56), height: 140),
                withAttributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.white.withAlphaComponent(0.85)])
        }
        NSColor.black.withAlphaComponent(0.28).setFill()
        bounds.fill()
        guard let global = selection.rectangle else { drawMagnifier(); return }
        let rect = global.offsetBy(dx: -viewport.minX, dy: -viewport.minY)
        if let image = frozen?.image {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(rect: rect.intersection(bounds)).addClip()
            NSImage(cgImage: image, size: bounds.size).draw(in: bounds)
            NSGraphicsContext.restoreGraphicsState()
        }
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
        drawMagnifier()
    }

    private func drawMagnifier() {
        guard let pixels = coordinator.pixels, let display = pixels.display(in: viewport),
              let sample = pixels.sample(at: coordinator.pointerLocation, in: display) else { return }
        let panel = magnifierFrame(at: coordinator.pointerLocation)
        NSColor(calibratedWhite: 0.085, alpha: 0.98).setFill()
        let outline = NSBezierPath(roundedRect: panel, xRadius: 10, yRadius: 10)
        outline.fill()
        NSColor.white.withAlphaComponent(0.18).setStroke(); outline.lineWidth = 1; outline.stroke()
        let compact = bounds.width < 420 || bounds.height < 320
        let cell: CGFloat = compact ? 6 : 7
        let horizontalRadius = compact ? 9 : 14, verticalRadius = compact ? 3 : 6
        let desired = CGRect(x: sample.x - horizontalRadius, y: sample.y - verticalRadius,
            width: horizontalRadius * 2 + 1, height: verticalRadius * 2 + 1)
        let lens = NSRect(x: panel.midX - desired.width * cell / 2, y: panel.minY + 60,
            width: desired.width * cell, height: desired.height * cell)
        let source = desired.intersection(CGRect(x: 0, y: 0, width: sample.image.width, height: sample.image.height))
        if let crop = sample.image.cropping(to: source) {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: lens, xRadius: 4, yRadius: 4).addClip()
            NSGraphicsContext.current?.imageInterpolation = .none
            let destination = NSRect(x: lens.minX + (source.minX - desired.minX) * cell,
                y: lens.maxY - (source.maxY - desired.minY) * cell, width: source.width * cell, height: source.height * cell)
            NSImage(cgImage: crop, size: NSSize(width: crop.width, height: crop.height)).draw(in: destination)
            NSGraphicsContext.restoreGraphicsState()
        }
        let cx = lens.midX, cy = lens.midY
        let cross = NSBezierPath()
        cross.move(to: NSPoint(x: lens.minX, y: cy)); cross.line(to: NSPoint(x: lens.maxX, y: cy))
        cross.move(to: NSPoint(x: cx, y: lens.minY)); cross.line(to: NSPoint(x: cx, y: lens.maxY))
        NSColor.black.withAlphaComponent(0.7).setStroke(); cross.lineWidth = 2; cross.stroke()
        NSColor.white.withAlphaComponent(0.9).setStroke(); cross.lineWidth = 0.6; cross.stroke()
        let quartzX = coordinator.pointerLocation.x
        let quartzY = coordinator.primaryDisplayTop - coordinator.pointerLocation.y
        let mono = NSFont.monospacedSystemFont(ofSize: compact ? 10 : 11, weight: .medium)
        let label: [NSAttributedString.Key: Any] = [.font: mono, .foregroundColor: NSColor.white]
        "\(sample.hex)  RGB \(sample.red),\(sample.green),\(sample.blue)".draw(at: NSPoint(x: panel.minX + 10, y: panel.minY + 42), withAttributes: label)
        String(format: "全局 %.0f, %.0f pt", quartzX, quartzY)
            .draw(at: NSPoint(x: panel.minX + 10, y: panel.minY + 25), withAttributes: [.font: mono, .foregroundColor: NSColor.white.withAlphaComponent(0.6)])
        "屏内 \(sample.x), \(sample.y) px"
            .draw(at: NSPoint(x: panel.minX + 10, y: panel.minY + 9), withAttributes: [.font: mono, .foregroundColor: NSColor.white.withAlphaComponent(0.6)])
    }

    private func magnifierFrame(at location: NSPoint) -> NSRect {
        let point = NSPoint(x: location.x - viewport.minX, y: location.y - viewport.minY)
        let compact = bounds.width < 420 || bounds.height < 320
        let size = compact ? NSSize(width: 172, height: 112) : NSSize(width: 224, height: 160)
        let origins = [NSPoint(x: point.x + 24, y: point.y - size.height - 24),
            NSPoint(x: point.x - size.width - 24, y: point.y - size.height - 24),
            NSPoint(x: point.x + 24, y: point.y + 24),
            NSPoint(x: point.x - size.width - 24, y: point.y + 24),
            NSPoint(x: bounds.minX + 12, y: bounds.maxY - size.height - 12),
            NSPoint(x: bounds.minX + 12, y: bounds.minY + 12)]
        let candidates = origins.map { NativeSelectionState.panelFrame(size: size, preferredOrigin: $0, screen: bounds) }
        let occupied = [coordinator.toolbarFrame(in: self), coordinator.dimensionFrame(in: self),
            NSRect(x: point.x - 12, y: point.y - 12, width: 24, height: 24)].compactMap { $0 }
        return candidates.first { frame in !occupied.contains { frame.intersects($0) } } ?? candidates.last!
    }
    fileprivate func invalidateMagnifier(at point: NSPoint) {
        if viewport.contains(point) { setNeedsDisplay(magnifierFrame(at: point).insetBy(dx: -2, dy: -2)) }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let motionTracking { removeTrackingArea(motionTracking) }
        let tracking = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(tracking); motionTracking = tracking
    }
    override func mouseMoved(with event: NSEvent) { coordinator.pointerMoved(globalPoint(event)) }
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
    var primaryDisplayTop: CGFloat { primaryTop }
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
    let loading = NativeSelectionLoading()
    private(set) var pixels: NativeSelectionPixels?
    private(set) var pointerLocation: NSPoint

    init(screenFrames: [NSRect], primaryTop: CGFloat, initialPoint: NSPoint, allowEditing: Bool,
         previousApp: NSRunningApplication? = nil, pixels: NativeSelectionPixels? = nil,
         completion: ((Result<NativeSelectionChoice?, Error>) -> Void)? = nil) {
        self.screenFrames = screenFrames
        self.primaryTop = primaryTop
        self.initialPoint = initialPoint
        pointerLocation = initialPoint
        self.pixels = pixels
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
    func dimensionFrame(in view: NativeScreenSelection) -> NSRect? { dimensions.superview === view && !dimensions.isHidden ? dimensions.frame : nil }

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
        sizeLabel.lineBreakMode = .byWordWrapping
        sizeLabel.maximumNumberOfLines = 0
        dimensions.addSubview(sizeLabel)
        dimensions.isPassive = true
    }
    @objc private func confirm() { complete(action: .capture) }
    @objc private func edit() {
        guard allowEditing else { return }
        complete(action: .edit)
    }
    private func complete(action: NativeSelectionCompletionAction) {
        guard selection.canConfirm, let rect = selection.rectangle, let pixels else { return }
        let quartz = NativeCaptureGeometry.quartzRect(appKitRect: rect, primaryDisplayTop: primaryTop)
        guard pixels.issue(in: quartz) == nil else { return }
        finish(.success(NativeSelectionChoice(rectangle: quartz, completionAction: action, pixels: pixels)))
    }
    @objc fileprivate func cancel() { finish(.success(nil)) }
    @objc fileprivate func displayConfigurationChanged() {
        finish(.failure(NativeScreenSelectionError(code: "display_configuration_changed", message: "display geometry changed during the original selection; choose the region again")))
    }
    private func finish(_ result: Result<NativeSelectionChoice?, Error>) {
        guard let callback = completion else { return }
        completion = nil
        loading.cancel()
        NotificationCenter.default.removeObserver(self)
        NativeScreenSelection.closePresentation(for: self)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier {
            previousApp?.activate(options: [.activateIgnoringOtherApps])
        }
        callback(result)
    }

    func loaded(_ result: Result<NativeSelectionPixels, Error>) {
        guard completion != nil, !loading.isCancelled else { return }
        switch result {
        case let .success(value):
            guard value.displays.count == screenFrames.count,
                  value.displays.allSatisfy({ screenFrames.contains($0.appKitFrame) }) else {
                finish(.failure(NativeScreenSelectionError(code: "display_configuration_changed", message: "the original display geometry changed before its frozen pixels became available")))
                return
            }
            guard value.displays.contains(where: { $0.image != nil }) else {
                let issue = value.displays.compactMap(\.issue).joined(separator: "\n")
                finish(.failure(NativeScreenSelectionError(code: "display_capture_unavailable", message: issue.isEmpty ? "macOS did not provide any original display pixels" : issue)))
                return
            }
            pixels = value
            refresh()
        case let .failure(error): finish(.failure(error))
        }
    }

    func pointerMoved(_ point: NSPoint) {
        guard point != pointerLocation else { return }
        for view in views.allObjects { view.invalidateMagnifier(at: pointerLocation) }
        pointerLocation = point
        for view in views.allObjects { view.invalidateMagnifier(at: point) }
    }
    func pointerDown(_ point: NSPoint) {
        guard pixels != nil else { return }
        preferredPoint = point; pointerLocation = point; selection.pointerDown(point); refresh()
    }
    func pointerDragged(_ point: NSPoint) { pointerLocation = point; selection.pointerDragged(point); refresh() }
    func pointerUp(_ point: NSPoint) { pointerLocation = point; selection.pointerUp(point); refresh() }
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
        let quartz = selection.rectangle.map { NativeCaptureGeometry.quartzRect(appKitRect: $0, primaryDisplayTop: primaryTop) }
        let issue = quartz.flatMap { pixels?.issue(in: $0) }
        confirmButton.isEnabled = selection.canConfirm && pixels != nil && issue == nil
        editButton.isEnabled = confirmButton.isEnabled
        hint.stringValue = pixels == nil ? "正在冻结屏幕 · Esc 随时取消" : "拖动选择截图区域"
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
            if let pixels, let quartz {
                let output = pixels.geometry(in: quartz)
                sizeLabel.stringValue = issue == nil ? "\(output.width) × \(output.height) px  ·  \(dimension(rect.width)) × \(dimension(rect.height)) pt" : "选区包含不可用屏幕"
            } else { sizeLabel.stringValue = "\(dimension(rect.width)) × \(dimension(rect.height)) pt" }
            sizeLabel.toolTip = issue
            let textWidth = max(1, screen.width - 36)
            let measured = (sizeLabel.stringValue as NSString).boundingRect(with: NSSize(width: textWidth - 20, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: sizeLabel.font!])
            let size = NSSize(width: min(textWidth, ceil(measured.width) + 20), height: ceil(measured.height) + 14)
            dimensions.frame = NativeSelectionState.dimensionPanelFrame(size: size, selection: rect, toolbar: toolbar.frame, screen: screen)
            sizeLabel.frame = NSRect(x: 10, y: 7, width: max(0, dimensions.bounds.width - 20), height: max(0, dimensions.bounds.height - 14))
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
