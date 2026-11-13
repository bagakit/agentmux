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
    /// Frozen displays kept behind an inline editor, by backdrop id. Only the
    /// owner's explicit release or its connection closing removes one.
    private static var backdrops: [String: NSWindow] = [:]
    /// Drawn as the editor's still background: no handles, controls or loupe.
    fileprivate var isBackdrop = false
    private let coordinator: NativeSelectionCoordinator
    let viewport: NSRect
    private var motionTracking: NSTrackingArea?
    var selection: NativeSelectionState { coordinator.selection }
    var frozenPixels: NativeSelectionPixels? { coordinator.pixels }
    var pointerLocation: NSPoint { coordinator.pointerLocation }
    var colorCopyFeedback: String { coordinator.colorCopyFeedback }
    var magnifierRectangle: NSRect? { coordinator.magnifierVisible ? magnifierFrame(at: coordinator.pointerLocation) : nil }
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

    /// `initialRect` is a global Quartz rectangle proposed by the host.
    static func begin(allowEditing: Bool = false, initialRect: CGRect? = nil, inlineEditing: Bool = false,
        copyColor: @escaping @Sendable (String) throws -> Void,
        load: @escaping @Sendable (NativeSelectionLoading) throws -> NativeSelectionPixels,
        completion: @escaping (Result<NativeSelectionChoice?, Error>) -> Void) throws {
        guard active == nil else { throw NativeScreenSelectionError(code: "capture_busy", message: "the original native selection is still active") }
        let screens = NSScreen.screens
        guard let primary = screens.first else {
            throw NativeScreenSelectionError(code: "display_unavailable", message: "macOS did not provide an active selection display")
        }
        let coordinator = NativeSelectionCoordinator(screenFrames: screens.map(\.frame), primaryTop: primary.frame.maxY,
            initialPoint: NSEvent.mouseLocation, allowEditing: allowEditing, inlineEditing: inlineEditing, previousApp: NSWorkspace.shared.frontmostApplication,
            copyColor: copyColor, completion: completion)
        if let initialRect {
            // Quartz and AppKit flip about the same primary top in both directions.
            coordinator.seed(NativeCaptureGeometry.quartzRect(appKitRect: initialRect, primaryDisplayTop: primary.frame.maxY))
        }
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

    /// Closes every display overlay, except `keeping`, which stays on screen
    /// as a passive frozen backdrop and is returned under a new id.
    fileprivate static func closePresentation(for coordinator: NativeSelectionCoordinator, keeping display: NSRect? = nil) -> String? {
        guard let presentation = active, presentation.coordinator === coordinator else { return nil }
        active = nil
        var kept: String?
        for window in presentation.windows {
            if let display, kept == nil, let view = window.contentView as? NativeScreenSelection, view.viewport == display {
                view.becomeBackdrop()
                window.ignoresMouseEvents = true
                window.resignKey()
                let id = UUID().uuidString
                backdrops[id] = window
                kept = id
                continue
            }
            window.orderOut(nil)
            window.close()
        }
        return kept
    }
    /// Main thread only.
    static func releaseBackdrop(_ id: String) -> Bool {
        guard let window = backdrops.removeValue(forKey: id) else { return false }
        window.orderOut(nil)
        window.close()
        return true
    }
    static func releaseBackdrops(_ ids: [String]) { for id in ids { _ = releaseBackdrop(id) } }
    static var backdropCount: Int { backdrops.count }
    private func becomeBackdrop() {
        isBackdrop = true
        for subview in subviews { subview.isHidden = true }
        window?.makeFirstResponder(nil)
        discardCursorRects()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let frozen = coordinator.pixels?.display(in: viewport)
        if let image = frozen?.image {
            NSImage(cgImage: image, size: bounds.size).draw(in: bounds)
        } else if let issue = frozen?.issue {
            NSColor(calibratedWhite: 0.09, alpha: 1).setFill()
            bounds.fill()
            let text = "This display cannot be captured right now\n\(issue)\n\nOther displays remain selectable · Esc to cancel"
            text.draw(in: NSRect(x: 28, y: bounds.midY - 60, width: max(1, bounds.width - 56), height: 140),
                withAttributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.white.withAlphaComponent(0.85)])
        }
        NSColor.black.withAlphaComponent(0.28).setFill()
        bounds.fill()
        if isBackdrop {
            // The editor draws its own chrome; the backdrop only shows which
            // frozen region it is editing.
            if let global = selection.rectangle, let image = frozen?.image {
                let rect = global.offsetBy(dx: -viewport.minX, dy: -viewport.minY)
                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(rect: rect.intersection(bounds)).addClip()
                NSImage(cgImage: image, size: bounds.size).draw(in: bounds)
                NSGraphicsContext.restoreGraphicsState()
                let border = NSBezierPath(rect: rect.insetBy(dx: -0.5, dy: -0.5))
                border.lineWidth = 1
                NSColor.white.withAlphaComponent(0.6).setStroke()
                border.stroke()
            }
            return
        }
        if let global = selection.rectangle {
            let rect = global.offsetBy(dx: -viewport.minX, dy: -viewport.minY)
            if let image = frozen?.image {
                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(rect: rect.intersection(bounds)).addClip()
                NSImage(cgImage: image, size: bounds.size).draw(in: bounds)
                NSGraphicsContext.restoreGraphicsState()
            }
            let outer = NSBezierPath(rect: rect.insetBy(dx: -1.5, dy: -1.5))
            outer.lineWidth = 1
            NSColor.black.withAlphaComponent(0.35).setStroke()
            outer.stroke()
            let inner = NSBezierPath(rect: rect.insetBy(dx: -0.5, dy: -0.5))
            inner.lineWidth = 1
            NSColor.white.setStroke()
            inner.stroke()
            for handle in NativeSelectionState.Handle.allCases {
                guard let globalPoint = selection.point(for: handle) else { continue }
                let point = NSPoint(x: globalPoint.x - viewport.minX, y: globalPoint.y - viewport.minY)
                let dot = NSBezierPath(ovalIn: NSRect(x: point.x - 3.5, y: point.y - 3.5, width: 7, height: 7))
                NSColor.white.setFill()
                dot.fill()
                NSColor.black.withAlphaComponent(0.35).setStroke()
                dot.lineWidth = 1
                dot.stroke()
            }
        }
        drawMagnifier()
    }

    /// 15 x 15 frozen pixels at 8pt each, then colour and the two coordinate
    /// spaces. A third row appears only while a colour copy has a receipt.
    private static let magnifierRadius = 7
    private static let magnifierCell: CGFloat = 8
    private func drawMagnifier() {
        guard coordinator.magnifierVisible, let pixels = coordinator.pixels, let display = pixels.display(in: viewport),
              let sample = pixels.sample(at: coordinator.pointerLocation, in: display) else { return }
        let panel = magnifierFrame(at: coordinator.pointerLocation)
        let outline = NSBezierPath(roundedRect: panel.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        NSColor(calibratedWhite: 0.08, alpha: 0.94).setFill()
        outline.fill()
        NSColor.white.withAlphaComponent(0.1).setStroke(); outline.lineWidth = 1; outline.stroke()
        let radius = Self.magnifierRadius, cell = Self.magnifierCell, count = radius * 2 + 1
        let span = CGFloat(count) * cell
        let lens = NSRect(x: panel.minX + 8, y: panel.maxY - 8 - span, width: span, height: span)
        let desired = CGRect(x: sample.x - radius, y: sample.y - radius, width: count, height: count)
        let source = desired.intersection(CGRect(x: 0, y: 0, width: sample.image.width, height: sample.image.height))
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: lens, xRadius: 5, yRadius: 5).addClip()
        NSColor.black.setFill()
        lens.fill()
        if let crop = sample.image.cropping(to: source) {
            NSGraphicsContext.current?.imageInterpolation = .none
            let destination = NSRect(x: lens.minX + (source.minX - desired.minX) * cell,
                y: lens.maxY - (source.maxY - desired.minY) * cell, width: source.width * cell, height: source.height * cell)
            NSImage(cgImage: crop, size: NSSize(width: crop.width, height: crop.height)).draw(in: destination)
        }
        let grid = NSBezierPath()
        for index in 1..<count {
            let offset = CGFloat(index) * cell
            grid.move(to: NSPoint(x: lens.minX + offset, y: lens.minY)); grid.line(to: NSPoint(x: lens.minX + offset, y: lens.maxY))
            grid.move(to: NSPoint(x: lens.minX, y: lens.minY + offset)); grid.line(to: NSPoint(x: lens.maxX, y: lens.minY + offset))
        }
        grid.lineWidth = 0.5
        NSColor.black.withAlphaComponent(0.16).setStroke(); grid.stroke()
        NSGraphicsContext.restoreGraphicsState()
        let target = NSRect(x: lens.minX + CGFloat(radius) * cell, y: lens.minY + CGFloat(radius) * cell, width: cell, height: cell)
        let halo = NSBezierPath(rect: target.insetBy(dx: -0.5, dy: -0.5))
        NSColor.black.withAlphaComponent(0.6).setStroke(); halo.lineWidth = 1; halo.stroke()
        let marker = NSBezierPath(rect: target.insetBy(dx: 0.5, dy: 0.5))
        NSColor.white.setStroke(); marker.lineWidth = 1; marker.stroke()
        let lensOutline = NSBezierPath(roundedRect: lens.insetBy(dx: -0.5, dy: -0.5), xRadius: 5.5, yRadius: 5.5)
        NSColor.white.withAlphaComponent(0.12).setStroke(); lensOutline.lineWidth = 1; lensOutline.stroke()
        let quartzX = floor(coordinator.pointerLocation.x)
        let quartzY = floor(coordinator.primaryDisplayTop - coordinator.pointerLocation.y)
        var rows: [(String, CGFloat)] = [("\(sample.hex)  \(sample.red),\(sample.green),\(sample.blue)", 0.95),
            (String(format: "%.0f, %.0f pt", quartzX, quartzY) + " · \(sample.x), \(sample.y) px", 0.6)]
        if coordinator.colorCopyStatusVisible { rows.append((coordinator.colorCopyFeedback, 0.95)) }
        for (index, row) in rows.enumerated() {
            // Large multi-display coordinates shrink to the lens width rather
            // than truncate a digit away.
            var size: CGFloat = 10
            var attributes: [NSAttributedString.Key: Any] { [.font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .medium),
                .foregroundColor: NSColor.white.withAlphaComponent(row.1)] }
            while size > 8 && (row.0 as NSString).size(withAttributes: attributes).width > span { size -= 0.5 }
            (row.0 as NSString).draw(with: NSRect(x: lens.minX, y: lens.minY - 18 - CGFloat(index) * 13, width: span, height: 13),
                options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes)
        }
    }

    private func magnifierFrame(at location: NSPoint) -> NSRect {
        let point = NSPoint(x: location.x - viewport.minX, y: location.y - viewport.minY)
        let rows: CGFloat = coordinator.colorCopyStatusVisible ? 3 : 2
        let size = NSSize(width: 136, height: 8 + CGFloat(Self.magnifierRadius * 2 + 1) * Self.magnifierCell + 5 + rows * 13 + 6)
        var origins = [NSPoint(x: point.x + 24, y: point.y - size.height - 24),
            NSPoint(x: point.x - size.width - 24, y: point.y - size.height - 24),
            NSPoint(x: point.x + 24, y: point.y + 24),
            NSPoint(x: point.x - size.width - 24, y: point.y + 24)]
        // While a selection moves the pointer is inside it; keep the loupe
        // just outside the nearest edge rather than in a far screen corner.
        if let rect = selection.rectangle.map({ $0.offsetBy(dx: -viewport.minX, dy: -viewport.minY) }) {
            origins += [NSPoint(x: rect.maxX + 16, y: point.y - size.height / 2), NSPoint(x: rect.minX - size.width - 16, y: point.y - size.height / 2),
                NSPoint(x: point.x - size.width / 2, y: rect.minY - size.height - 16), NSPoint(x: point.x - size.width / 2, y: rect.maxY + 16)]
        }
        origins += [NSPoint(x: bounds.minX + 12, y: bounds.maxY - size.height - 12),
            NSPoint(x: bounds.maxX - size.width - 12, y: bounds.maxY - size.height - 12),
            NSPoint(x: bounds.minX + 12, y: bounds.minY + 12),
            NSPoint(x: bounds.maxX - size.width - 12, y: bounds.minY + 12)]
        let candidates = origins.map { NativeSelectionState.panelFrame(size: size, preferredOrigin: $0, screen: bounds) }
        var occupied = coordinator.controlFrames(in: self) + [NSRect(x: point.x - 12, y: point.y - 12, width: 24, height: 24)]
        let selected = selection.rectangle.map { $0.offsetBy(dx: -viewport.minX, dy: -viewport.minY) }
        if let selected { occupied.append(selected) }
        return candidates.first { frame in !occupied.contains { frame.intersects($0) } } ?? candidates[0]
    }
    fileprivate func invalidateMagnifier(at point: NSPoint) {
        if coordinator.magnifierVisible && viewport.contains(point) { setNeedsDisplay(magnifierFrame(at: point).insetBy(dx: -2, dy: -2)) }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let motionTracking { removeTrackingArea(motionTracking) }
        let tracking = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(tracking); motionTracking = tracking
    }
    override func mouseMoved(with event: NSEvent) { coordinator.pointerMoved(globalPoint(event)) }
    override func resetCursorRects() {
        guard !isBackdrop else { return }
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
        for frame in coordinator.interactiveFrames(in: self) { addCursorRect(frame, cursor: .arrow) }
    }

    private func globalPoint(_ event: NSEvent) -> NSPoint {
        // A drag continues to arrive at its original down view even outside
        // that window. A nil-window mouse event already uses screen coordinates.
        event.window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = globalPoint(event)
        if event.clickCount == 2, selection.rectangle?.contains(point) == true {
            coordinator.confirmFromGesture()
            return
        }
        coordinator.pointerDown(point)
    }
    override func rightMouseDown(with event: NSEvent) { coordinator.secondaryClick(globalPoint(event)) }
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
    private struct QuickMark { let tool: String; let label: String; let symbol: String; let key: String; let keyCode: UInt16 }
    private static let quickMarks = [
        QuickMark(tool: "rect", label: "Rectangle", symbol: "rectangle", key: "R", keyCode: 15),
        QuickMark(tool: "arrow", label: "Arrow", symbol: "arrow.up.right", key: "A", keyCode: 0),
        QuickMark(tool: "note", label: "Numbered note", symbol: "1.circle", key: "N", keyCode: 45),
        QuickMark(tool: "pixelate", label: "Pixelate", symbol: "checkerboard.rectangle", key: "M", keyCode: 46),
        QuickMark(tool: "text", label: "Text", symbol: "textformat", key: "T", keyCode: 17),
    ]
    private(set) var selection: NativeSelectionState
    let initialPoint: NSPoint
    private var preferredPoint: NSPoint
    private let primaryTop: CGFloat
    var primaryDisplayTop: CGFloat { primaryTop }
    private let screenFrames: [NSRect]
    private let allowEditing: Bool
    private let inlineEditing: Bool
    private let previousApp: NSRunningApplication?
    private let copyColor: (@Sendable (String) throws -> Void)?
    private var colorCopyOperation: UUID?
    private let colorCopyQueue = DispatchQueue(label: "com.agentmux.native.selection-color-copy", qos: .userInitiated)
    private(set) var colorCopyFeedback = "C copies color"
    /// The receipt row stays until the pointer moves away from the copied pixel.
    private(set) var colorCopyStatusVisible = false
    private var completion: ((Result<NativeSelectionChoice?, Error>) -> Void)?
    private let views = NSHashTable<NativeScreenSelection>.weakObjects()
    private var controlsViewport: NSRect?
    private let toolbar = NativeSelectionPanel(style: .toolbar)
    private let marksTray = NativeSelectionPanel(style: .toolbar)
    private let dimensions = NativeSelectionPanel(style: .chip)
    private let hintPanel = NativeSelectionPanel(style: .chip)
    private let separator = NativeSelectionSeparator(frame: .zero)
    private let confirmButton = NativeSelectionButton(label: "Done", toolTip: "Capture (Return)", shortcut: "↵", primary: true)
    private let cancelButton = NativeSelectionButton(label: "Cancel", toolTip: "Cancel (Esc)", symbol: "xmark")
    private let editButton = NativeSelectionButton(label: "Open full editor", toolTip: "Open full editor (E)", symbol: "arrow.up.left.and.arrow.down.right")
    private let marksButton = NativeSelectionButton(label: "Markup", toolTip: "Markup", symbol: "scribble.variable")
    private let markButtons = NativeSelectionCoordinator.quickMarks.map {
        NativeSelectionButton(label: $0.label, toolTip: "\($0.label) (\($0.key))", symbol: $0.symbol)
    }
    private var marksTrayOpen = false
    let loading = NativeSelectionLoading()
    private(set) var pixels: NativeSelectionPixels?
    private(set) var pointerLocation: NSPoint
    /// The loupe serves aiming: before a selection exists and while it moves.
    var magnifierVisible: Bool { selection.rectangle == nil || selection.isInteracting || colorCopyStatusVisible }

    init(screenFrames: [NSRect], primaryTop: CGFloat, initialPoint: NSPoint, allowEditing: Bool, inlineEditing: Bool = false,
         previousApp: NSRunningApplication? = nil, pixels: NativeSelectionPixels? = nil,
         copyColor: (@Sendable (String) throws -> Void)? = nil,
         completion: ((Result<NativeSelectionChoice?, Error>) -> Void)? = nil) {
        self.screenFrames = screenFrames
        self.primaryTop = primaryTop
        self.initialPoint = initialPoint
        pointerLocation = initialPoint
        self.pixels = pixels
        preferredPoint = initialPoint
        self.allowEditing = allowEditing
        self.inlineEditing = inlineEditing && allowEditing
        self.previousApp = previousApp
        self.copyColor = copyColor
        self.completion = completion
        selection = NativeSelectionState(bounds: screenFrames.reduce(NSRect.null) { $0.union($1) })
        super.init()
        buildControls()
    }
    func register(_ view: NativeScreenSelection) {
        views.add(view)
        view.setAccessibilityHelp(accessibilityGuide)
        refresh()
    }
    private var accessibilityGuide: String {
        "Drag to select an area. Drag inside it to move, drag a handle to resize, and use the arrow keys to nudge. C copies the color under the pointer. Return captures and Esc cancels."
            + (allowEditing ? " E opens the full editor." : "")
    }
    func controlFrames(in view: NativeScreenSelection) -> [NSRect] {
        [toolbar, marksTray, dimensions, hintPanel].filter { $0.superview === view && !$0.isHidden }.map(\.frame)
    }
    func interactiveFrames(in view: NativeScreenSelection) -> [NSRect] {
        [toolbar, marksTray].filter { $0.superview === view && !$0.isHidden }.map(\.frame)
    }

    private func buildControls() {
        toolbar.identifier = NSUserInterfaceItemIdentifier("native-selection-toolbar")
        marksTray.identifier = NSUserInterfaceItemIdentifier("native-selection-marks-tray")
        dimensions.identifier = NSUserInterfaceItemIdentifier("native-selection-dimensions")
        hintPanel.identifier = NSUserInterfaceItemIdentifier("native-selection-hint")
        let named = [(confirmButton, "native-selection-confirm"), (cancelButton, "native-selection-cancel"),
            (editButton, "native-selection-edit"), (marksButton, "native-selection-marks")]
            + zip(markButtons, Self.quickMarks).map { ($0, "native-selection-mark-" + $1.tool) }
        for (button, identifier) in named {
            button.identifier = NSUserInterfaceItemIdentifier(identifier)
            button.setAccessibilityIdentifier(identifier)
            button.target = self
        }
        confirmButton.action = #selector(confirm)
        cancelButton.action = #selector(cancel)
        editButton.action = #selector(edit)
        marksButton.action = #selector(toggleMarks)
        for button in markButtons { button.action = #selector(mark(_:)) }
        confirmButton.keyEquivalent = "\r"
        cancelButton.keyEquivalent = "\u{1b}"
        editButton.keyEquivalent = "e"
        editButton.keyEquivalentModifierMask = []
        toolbar.addSubview(cancelButton)
        toolbar.addSubview(confirmButton)
        toolbar.isHidden = true
        marksTray.isHidden = true
        hintPanel.textFont = .systemFont(ofSize: 12, weight: .medium)
        hintPanel.textPadding = 12
        hintPanel.isPassive = true
        dimensions.textFont = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        dimensions.isPassive = true
    }
    @objc private func confirm() { complete(action: .capture) }
    /// A double click inside the resting selection; the first click of the
    /// pair has already ended as a zero-distance move.
    func confirmFromGesture() { confirm() }
    /// Secondary click backs out one level: an outside click drops the
    /// selection, a click with no selection cancels the request.
    func secondaryClick(_ point: NSPoint) {
        guard let rect = selection.rectangle else { cancel(); return }
        guard !rect.contains(point) else { return }
        selection.clear()
        refresh()
    }
    func seed(_ appKitRect: NSRect) { selection.seed(appKitRect); refresh() }
    @objc private func edit() {
        guard allowEditing else { return }
        complete(action: .edit)
    }
    @objc private func mark(_ sender: NSButton) {
        guard allowEditing, let index = markButtons.firstIndex(where: { $0 === sender }) else { return }
        complete(action: .edit, tool: Self.quickMarks[index].tool)
    }
    @objc private func toggleMarks() { marksTrayOpen.toggle(); refresh() }
    private func complete(action: NativeSelectionCompletionAction, tool: String? = nil) {
        guard selection.canConfirm, let rect = selection.rectangle, let pixels else { return }
        let quartz = NativeCaptureGeometry.quartzRect(appKitRect: rect, primaryDisplayTop: primaryTop)
        guard pixels.issue(in: quartz) == nil else { return }
        // An inline editor opens over the same frozen display, so that one
        // display stays as its backdrop. A selection across displays has no
        // single backdrop and closes normally.
        let holding = action == .edit && inlineEditing ? screenFrames.filter { $0.contains(rect) } : []
        let display = holding.count == 1 ? holding[0] : nil
        finish(.success(nil), keeping: display) { backdrop in
            NativeSelectionChoice(rectangle: quartz, completionAction: action, editTool: action == .edit ? tool : nil, backdrop: backdrop, pixels: pixels)
        }
    }
    @objc fileprivate func cancel() { finish(.success(nil)) }
    @objc fileprivate func displayConfigurationChanged() {
        finish(.failure(NativeScreenSelectionError(code: "display_configuration_changed", message: "display geometry changed during the original selection; choose the region again")))
    }
    private func finish(_ result: Result<NativeSelectionChoice?, Error>, keeping display: NSRect? = nil,
                        choice: ((String?) -> NativeSelectionChoice)? = nil) {
        guard let callback = completion else { return }
        completion = nil
        loading.cancel()
        NotificationCenter.default.removeObserver(self)
        let backdrop = NativeScreenSelection.closePresentation(for: self, keeping: display)
        // The host's editor takes focus over a kept backdrop; handing focus
        // back to the previous app would put it between them.
        if backdrop == nil, NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier {
            previousApp?.activate(options: [.activateIgnoringOtherApps])
        }
        callback(choice.map { .success($0(backdrop)) } ?? result)
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
        colorCopyStatusVisible = false
        for view in views.allObjects { view.invalidateMagnifier(at: point) }
    }
    func pointerDown(_ point: NSPoint) {
        guard pixels != nil else { return }
        preferredPoint = point; pointerLocation = point; colorCopyStatusVisible = false; selection.pointerDown(point); refresh()
    }
    func pointerDragged(_ point: NSPoint) { pointerLocation = point; selection.pointerDragged(point); refresh() }
    func pointerUp(_ point: NSPoint) { pointerLocation = point; selection.pointerUp(point); refresh() }
    func handleKey(_ event: NSEvent) -> Bool {
        let step: CGFloat = event.modifierFlags.contains(.shift) ? 10 : 1
        let plain = event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty
        if allowEditing, plain, let mark = Self.quickMarks.first(where: { $0.keyCode == event.keyCode }) {
            // A quick-mark key is consumed even before a selection exists, so
            // it can never fall through to another responder as a shortcut.
            if confirmButton.isEnabled { complete(action: .edit, tool: mark.tool) }
            return true
        }
        switch event.keyCode {
        case 53: cancel()
        case 36, 76: confirm()
        case 8 where event.modifierFlags.intersection([.command, .control, .option]).isEmpty: copyPointerColor()
        case 14 where event.modifierFlags.intersection([.command, .control, .option]).isEmpty: edit()
        case 123: selection.nudge(dx: -step, dy: 0); refresh()
        case 124: selection.nudge(dx: step, dy: 0); refresh()
        case 125: selection.nudge(dx: 0, dy: -step); refresh()
        case 126: selection.nudge(dx: 0, dy: step); refresh()
        default: return false
        }
        return true
    }

    private func showColorCopy(_ feedback: String) {
        for view in views.allObjects { view.invalidateMagnifier(at: pointerLocation) }
        colorCopyFeedback = feedback
        colorCopyStatusVisible = true
        for view in views.allObjects { view.invalidateMagnifier(at: pointerLocation) }
    }
    private func copyPointerColor() {
        guard let pixels, let display = pixels.displays.first(where: { $0.appKitFrame.contains(pointerLocation) }),
              let sample = pixels.sample(at: pointerLocation, in: display) else {
            showColorCopy("No pixel here · press C to retry")
            return
        }
        let write: @Sendable (String) throws -> Void = copyColor ?? { _ in
            throw NativeScreenSelectionError(code: "clipboard_unavailable", message: "the original selection has no color-copy owner")
        }
        let operation = UUID(), hex = sample.hex
        colorCopyOperation = operation
        showColorCopy("Copying \(hex)")
        // The existing clipboard owner serializes on its worker. Waiting for
        // that owner on AppKit's main thread would deadlock its main dispatch.
        colorCopyQueue.async { [weak self] in
            let failure: String?
            do { try write(hex); failure = nil }
            catch { failure = String(describing: error) }
            DispatchQueue.main.async {
                guard let self, self.completion != nil, self.colorCopyOperation == operation else { return }
                self.colorCopyFeedback = failure == nil ? "Copied \(hex)" : "Copy unconfirmed · press C to retry"
                for view in self.views.allObjects {
                    view.setAccessibilityHelp(failure.map { "Color copy unconfirmed: \($0). Press C to retry; the selection and Esc remain available." }
                        ?? "Copied color \(hex). Press C to copy again; Return captures and Esc cancels.")
                    view.invalidateMagnifier(at: self.pointerLocation)
                }
            }
        }
    }

    func refresh() {
        let quartz = selection.rectangle.map { NativeCaptureGeometry.quartzRect(appKitRect: $0, primaryDisplayTop: primaryTop) }
        let issue = quartz.flatMap { pixels?.issue(in: $0) }
        confirmButton.isEnabled = selection.canConfirm && pixels != nil && issue == nil
        for button in [editButton, marksButton] + markButtons { button.isEnabled = confirmButton.isEnabled }
        hintPanel.text = pixels == nil ? "Freezing screen · Esc to cancel" : "Drag to select · Esc to cancel"
        let globalScreen = currentScreen()
        guard let host = views.allObjects.first(where: { $0.viewport == globalScreen }) else { return }
        if toolbar.superview !== host {
            for panel in [hintPanel, dimensions, toolbar, marksTray] {
                panel.removeFromSuperview()
                host.addSubview(panel)
            }
        }
        controlsViewport = globalScreen
        let screen = NSRect(origin: .zero, size: globalScreen.size)
        let localRectangle = selection.rectangle?.offsetBy(dx: -globalScreen.minX, dy: -globalScreen.minY)
        hintPanel.isHidden = localRectangle != nil
        if localRectangle == nil { layoutHint(screen: screen) }
        let toolbarVisible = localRectangle != nil && !selection.isInteracting
        if !toolbarVisible { marksTrayOpen = false }
        if let rect = localRectangle, toolbarVisible { layoutToolbar(around: rect, screen: screen) }
        reveal(toolbar, visible: toolbarVisible)
        dimensions.isHidden = localRectangle == nil
        if let rect = localRectangle {
            if let pixels, let quartz {
                let output = pixels.geometry(in: quartz)
                dimensions.text = issue == nil ? "\(output.width) × \(output.height) px" : "Selection includes an unavailable display"
            } else { dimensions.text = "\(Int(rect.width.rounded())) × \(Int(rect.height.rounded())) pt" }
            dimensions.toolTip = issue
            var size = dimensions.fittingSize(height: 20)
            size.width = min(max(1, screen.width - 24), size.width)
            let toolbarFrame = toolbar.isHidden ? NSRect.null : toolbar.frame
            dimensions.frame = NativeSelectionState.dimensionPanelFrame(size: size, selection: rect, toolbar: toolbarFrame, screen: screen)
        }
        for view in views.allObjects {
            view.window?.invalidateCursorRects(for: view)
            view.needsDisplay = true
        }
    }
    private func layoutHint(screen: NSRect) {
        let size = hintPanel.fittingSize(height: 26)
        hintPanel.frame = NativeSelectionState.panelFrame(size: size,
            preferredOrigin: NSPoint(x: screen.midX - size.width / 2, y: screen.minY + 40), screen: screen)
    }
    /// One row only: below the selection, right edges aligned; then above;
    /// then inside its lower-right corner. Narrow space folds the marks.
    private func layoutToolbar(around rect: NSRect, screen: NSRect) {
        let height: CGFloat = 36, padding: CGFloat = 4, gap: CGFloat = 2, divider: CGFloat = 13
        let exits = [cancelButton, confirmButton]
        let width: ([NativeSelectionButton]) -> CGFloat = { group in
            group.reduce(0) { $0 + $1.preferredWidth } + CGFloat(max(0, group.count - 1)) * gap
        }
        let measure: ([[NativeSelectionButton]]) -> CGFloat = { groups in
            padding * 2 + groups.map(width).reduce(0, +) + CGFloat(max(0, groups.count - 1)) * divider
        }
        let full = allowEditing ? [markButtons + [editButton], exits] : [exits]
        let available = max(0, screen.width - 24)
        let collapsed = allowEditing && measure(full) > available
        let groups = collapsed ? [[marksButton, editButton], exits] : full
        let shown = groups.flatMap { $0 }
        for button in [marksButton, editButton] + markButtons where button.superview === toolbar && !shown.contains(where: { $0 === button }) {
            button.removeFromSuperview()
        }
        var x = padding
        for (index, group) in groups.enumerated() {
            if index > 0 {
                if separator.superview !== toolbar { toolbar.addSubview(separator) }
                separator.frame = NSRect(x: x + (divider - 1) / 2, y: (height - 16) / 2, width: 1, height: 16)
                x += divider
            }
            for (offset, button) in group.enumerated() {
                if offset > 0 { x += gap }
                if button.superview !== toolbar { toolbar.addSubview(button) }
                button.frame = NSRect(x: x, y: padding, width: button.preferredWidth, height: height - padding * 2)
                x += button.preferredWidth
            }
        }
        if groups.count < 2 { separator.removeFromSuperview() }
        let size = CGSize(width: x + padding, height: height)
        var origin = NSPoint(x: rect.maxX - size.width, y: rect.minY - 8 - size.height)
        if origin.y < screen.minY + 12 {
            origin.y = rect.maxY + 8
            if origin.y + size.height > screen.maxY - 12 { origin = NSPoint(x: rect.maxX - 12 - size.width, y: rect.minY + 12) }
        }
        toolbar.frame = NativeSelectionState.panelFrame(size: size, preferredOrigin: origin, screen: screen)
        marksTray.isHidden = !(collapsed && marksTrayOpen)
        guard collapsed else { return }
        var trayX = padding
        for button in markButtons {
            if button.superview !== marksTray { marksTray.addSubview(button) }
            button.frame = NSRect(x: trayX, y: padding, width: button.preferredWidth, height: height - padding * 2)
            trayX += button.preferredWidth + gap
        }
        let traySize = CGSize(width: trayX - gap + padding, height: height)
        var trayOrigin = NSPoint(x: toolbar.frame.minX + marksButton.frame.minX - padding, y: toolbar.frame.minY - 4 - height)
        if trayOrigin.y < screen.minY + 12 { trayOrigin.y = toolbar.frame.maxY + 4 }
        marksTray.frame = NativeSelectionState.panelFrame(size: traySize, preferredOrigin: trayOrigin, screen: screen)
    }
    private func reveal(_ panel: NSView, visible: Bool) {
        guard visible else { panel.isHidden = true; return }
        guard panel.isHidden else { return }
        panel.isHidden = false
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { panel.alphaValue = 1; return }
        panel.alphaValue = 0
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            panel.animator().alphaValue = 1
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
/// contracts. Secondary actions are icons; the one primary action is a label.
private final class NativeSelectionButton: NSButton {
    private let shortcut: String?
    private let primary: Bool
    private let symbol: String?
    private var hovered = false
    private var hoverTracking: NSTrackingArea?
    override var acceptsFirstResponder: Bool { true }

    init(label: String, toolTip: String, symbol: String? = nil, shortcut: String? = nil, primary: Bool = false) {
        self.shortcut = shortcut
        self.primary = primary
        self.symbol = symbol
        super.init(frame: .zero)
        title = label
        isBordered = false
        focusRingType = .none
        self.toolTip = toolTip
        setAccessibilityLabel(label)
    }
    required init?(coder: NSCoder) { nil }
    private var titleFont: NSFont { .systemFont(ofSize: 12, weight: .semibold) }
    private var keyFont: NSFont { .systemFont(ofSize: 11, weight: .regular) }
    var preferredWidth: CGFloat {
        guard primary else { return 28 }
        let label = (title as NSString).size(withAttributes: [.font: titleFont]).width
        let key = shortcut.map { ($0 as NSString).size(withAttributes: [.font: keyFont]).width + 5 } ?? 0
        return ceil(label + key + 24)
    }
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
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) != .aqua
        let accent = dark ? NSColor(srgbRed: 0x8d / 255.0, green: 0xe3 / 255.0, blue: 0xae / 255.0, alpha: 1)
            : NSColor(srgbRed: 0x26 / 255.0, green: 0x7a / 255.0, blue: 0x48 / 255.0, alpha: 1)
        let pressed = isEnabled && isHighlighted
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 6, yRadius: 6)
        if primary {
            (isEnabled ? accent.withAlphaComponent(pressed ? 0.78 : hovered ? 0.9 : 1) : NSColor.white.withAlphaComponent(0.08)).setFill()
            shape.fill()
        } else if isEnabled && (hovered || pressed) {
            NSColor.white.withAlphaComponent(pressed ? 0.16 : 0.1).setFill()
            shape.fill()
        }
        if window?.firstResponder === self {
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: 6.5, yRadius: 6.5)
            (primary ? NSColor.white : accent).setStroke()
            ring.lineWidth = 1.5
            ring.stroke()
        }
        let foreground: NSColor = !isEnabled ? NSColor.white.withAlphaComponent(0.32)
            : primary ? (dark ? NSColor(srgbRed: 0x0c / 255.0, green: 0x0e / 255.0, blue: 0x12 / 255.0, alpha: 1) : .white)
            : NSColor.white.withAlphaComponent(0.9)
        if primary {
            let label = title as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: titleFont, .foregroundColor: foreground]
            let keyAttributes: [NSAttributedString.Key: Any] = [.font: keyFont, .foregroundColor: foreground.withAlphaComponent(0.7)]
            let labelSize = label.size(withAttributes: attributes)
            let keySize = (shortcut ?? "").size(withAttributes: keyAttributes)
            let start = ((bounds.width - labelSize.width - (shortcut == nil ? 0 : keySize.width + 5)) / 2).rounded()
            label.draw(at: NSPoint(x: start, y: ((bounds.height - labelSize.height) / 2).rounded()), withAttributes: attributes)
            shortcut?.draw(at: NSPoint(x: start + labelSize.width + 5, y: ((bounds.height - keySize.height) / 2).rounded()), withAttributes: keyAttributes)
            return
        }
        let configuration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium).applying(.init(paletteColors: [foreground]))
        if let symbol, let image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)?.withSymbolConfiguration(configuration) {
            let size = image.size
            image.draw(in: NSRect(x: ((bounds.width - size.width) / 2).rounded(), y: ((bounds.height - size.height) / 2).rounded(), width: size.width, height: size.height))
        } else {
            let initial = String(title.prefix(1)) as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: titleFont, .foregroundColor: foreground]
            let size = initial.size(withAttributes: attributes)
            initial.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attributes)
        }
    }
}

/// Panels draw their own fill so AppKit view caching renders them exactly.
private final class NativeSelectionPanel: NSView {
    enum Style { case toolbar, chip }
    private let style: Style
    var isPassive = false
    /// Chips measure and draw their text with one attribute set, so the
    /// frame always fits the string it shows.
    var text = "" { didSet { if text != oldValue { needsDisplay = true; setAccessibilityValue(text) } } }
    var textFont = NSFont.systemFont(ofSize: 11, weight: .medium)
    var textPadding: CGFloat = 7
    private var textAttributes: [NSAttributedString.Key: Any] { [.font: textFont, .foregroundColor: NSColor.white.withAlphaComponent(0.94)] }
    func fittingSize(height: CGFloat) -> NSSize {
        NSSize(width: ceil((text as NSString).size(withAttributes: textAttributes).width) + textPadding * 2, height: height)
    }
    private var radius: CGFloat { style == .toolbar ? 10 : 6 }
    init(style: Style) {
        self.style = style
        super.init(frame: .zero)
        wantsLayer = true
        if style == .toolbar {
            layer?.shadowColor = NSColor.black.cgColor
            layer?.shadowOpacity = 0.25
            layer?.shadowRadius = 12
            layer?.shadowOffset = CGSize(width: 0, height: -3)
        } else {
            setAccessibilityElement(true)
            setAccessibilityRole(.staticText)
        }
    }
    required init?(coder: NSCoder) { nil }
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layer?.shadowPath = CGPath(roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
    }
    override func draw(_ dirtyRect: NSRect) {
        (style == .toolbar ? NSColor(calibratedWhite: 0.11, alpha: 0.92) : NSColor.black.withAlphaComponent(0.55)).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
        guard !text.isEmpty else { return }
        let size = (text as NSString).size(withAttributes: textAttributes)
        let origin = NSPoint(x: max(textPadding, ((bounds.width - size.width) / 2).rounded()), y: ((bounds.height - size.height) / 2).rounded())
        (text as NSString).draw(with: NSRect(x: origin.x, y: origin.y, width: max(0, bounds.width - origin.x - textPadding / 2), height: size.height),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: textAttributes)
    }
    override func hitTest(_ point: NSPoint) -> NSView? { isPassive ? nil : super.hitTest(point) }
    // Child buttons retain normal AppKit hit testing. Empty toolbar/label
    // events end here instead of bubbling into the parent's selection gesture.
    override func mouseDown(with event: NSEvent) {}
    override func mouseDragged(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) {}
    override func rightMouseDown(with event: NSEvent) {}
}
private final class NativeSelectionSeparator: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.withAlphaComponent(0.12).setFill()
        bounds.fill()
    }
}
private final class NativeSelectionWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
