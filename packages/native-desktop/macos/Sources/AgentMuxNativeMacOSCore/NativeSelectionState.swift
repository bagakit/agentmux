import CoreGraphics

/// Selection geometry is measured in logical AppKit points, independently of
/// the display scale used later by capture. No image or business identity lives here.
public struct NativeSelectionState {
    public static func panelFrame(size: CGSize, preferredOrigin: CGPoint, screen: CGRect, padding: CGFloat = 12) -> CGRect {
        let inset = min(padding, max(0, min(screen.width, screen.height) / 10))
        let available = screen.insetBy(dx: inset, dy: inset)
        let width = min(max(0, size.width), available.width), height = min(max(0, size.height), available.height)
        return CGRect(x: min(max(preferredOrigin.x, available.minX), available.maxX - width),
                      y: min(max(preferredOrigin.y, available.minY), available.maxY - height), width: width, height: height)
    }
    public static func dimensionPanelFrame(size: CGSize, selection: CGRect, toolbar: CGRect, screen: CGRect) -> CGRect {
        let origins = [
            CGPoint(x: selection.minX, y: selection.maxY + 8),
            CGPoint(x: selection.minX, y: selection.maxY - size.height - 8),
            CGPoint(x: selection.minX, y: selection.minY - size.height - 8),
            CGPoint(x: selection.minX, y: selection.minY + 8),
            CGPoint(x: selection.minX, y: toolbar.maxY + 8),
            CGPoint(x: selection.minX, y: toolbar.minY - size.height - 8),
        ]
        let candidates = origins.map { panelFrame(size: size, preferredOrigin: $0, screen: screen, padding: 8) }
        return candidates.first { !$0.intersects(toolbar) } ?? candidates[0]
    }
    public enum Handle: CaseIterable, Sendable, Equatable {
        case bottomLeft, bottom, bottomRight, right, topRight, top, topLeft, left
    }
    private enum Gesture {
        case create(CGPoint)
        case move(CGPoint, CGRect)
        case resize(Handle, CGRect)
    }
    public let bounds: CGRect
    public private(set) var rectangle: CGRect?
    private var gesture: Gesture?
    public var isInteracting: Bool { gesture != nil }
    public var canConfirm: Bool { rectangle.map(NativeCaptureGeometry.isValid) == true && !isInteracting }

    public init(bounds: CGRect) { self.bounds = bounds }

    public func point(for handle: Handle, in rect: CGRect? = nil) -> CGPoint? {
        guard let rect = rect ?? rectangle else { return nil }
        switch handle {
        case .bottomLeft: return CGPoint(x: rect.minX, y: rect.minY)
        case .bottom: return CGPoint(x: rect.midX, y: rect.minY)
        case .bottomRight: return CGPoint(x: rect.maxX, y: rect.minY)
        case .right: return CGPoint(x: rect.maxX, y: rect.midY)
        case .topRight: return CGPoint(x: rect.maxX, y: rect.maxY)
        case .top: return CGPoint(x: rect.midX, y: rect.maxY)
        case .topLeft: return CGPoint(x: rect.minX, y: rect.maxY)
        case .left: return CGPoint(x: rect.minX, y: rect.midY)
        }
    }

    public func handle(at location: CGPoint, tolerance: CGFloat = 8) -> Handle? {
        Handle.allCases.compactMap { handle -> (Handle, CGFloat)? in
            guard let point = point(for: handle) else { return nil }
            let distance = hypot(location.x - point.x, location.y - point.y)
            return distance <= tolerance ? (handle, distance) : nil
        }.min(by: { $0.1 < $1.1 })?.0
    }

    public mutating func pointerDown(_ location: CGPoint) {
        let location = clamped(location)
        if let rectangle, let handle = handle(at: location) {
            gesture = .resize(handle, rectangle)
        } else if let rectangle, rectangle.contains(location) {
            gesture = .move(location, rectangle)
        } else {
            rectangle = nil
            gesture = .create(location)
        }
    }

    public mutating func pointerDragged(_ location: CGPoint) {
        let location = clamped(location)
        switch gesture {
        case let .create(anchor):
            rectangle = CGRect(x: min(anchor.x, location.x), y: min(anchor.y, location.y),
                               width: abs(location.x - anchor.x), height: abs(location.y - anchor.y))
        case let .move(anchor, original):
            rectangle = translated(original, dx: location.x - anchor.x, dy: location.y - anchor.y)
        case let .resize(handle, original):
            var left = original.minX, right = original.maxX, bottom = original.minY, top = original.maxY
            let minimumWidth = min(1, original.width), minimumHeight = min(1, original.height)
            if [.bottomLeft, .topLeft, .left].contains(handle) { left = max(bounds.minX, min(location.x, right - minimumWidth)) }
            if [.bottomRight, .topRight, .right].contains(handle) { right = min(bounds.maxX, max(location.x, left + minimumWidth)) }
            if [.bottomLeft, .bottomRight, .bottom].contains(handle) { bottom = max(bounds.minY, min(location.y, top - minimumHeight)) }
            if [.topLeft, .topRight, .top].contains(handle) { top = min(bounds.maxY, max(location.y, bottom + minimumHeight)) }
            rectangle = CGRect(x: left, y: bottom, width: right - left, height: top - bottom)
        case nil: break
        }
    }

    public mutating func pointerUp(_ location: CGPoint) {
        pointerDragged(location)
        gesture = nil
        if let rectangle, !NativeCaptureGeometry.isValid(rectangle) { self.rectangle = nil }
    }

    public mutating func nudge(dx: CGFloat, dy: CGFloat) {
        guard let rectangle, !isInteracting else { return }
        self.rectangle = translated(rectangle, dx: dx, dy: dy)
    }

    private func clamped(_ point: CGPoint) -> CGPoint {
        CGPoint(x: min(max(point.x, bounds.minX), bounds.maxX), y: min(max(point.y, bounds.minY), bounds.maxY))
    }
    private func translated(_ rect: CGRect, dx: CGFloat, dy: CGFloat) -> CGRect {
        CGRect(x: min(max(rect.minX + dx, bounds.minX), bounds.maxX - rect.width),
               y: min(max(rect.minY + dy, bounds.minY), bounds.maxY - rect.height), width: rect.width, height: rect.height)
    }
}
