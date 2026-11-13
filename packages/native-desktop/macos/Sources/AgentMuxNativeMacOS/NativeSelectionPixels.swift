import CoreGraphics
import Foundation
import AgentMuxNativeMacOSCore

/// One request's immutable OS display pixels. Display identity and both native
/// coordinate frames stay with the image; a later display never supplies it.
struct NativeSelectionDisplay: @unchecked Sendable {
    let displayID: CGDirectDisplayID?
    let appKitFrame: CGRect
    let quartzFrame: CGRect
    let image: CGImage?
    let engine: String
    let issue: String?

    var scale: CGFloat { image.map { CGFloat($0.width) / quartzFrame.width } ?? 1 }
}

/// Cancellation releases the chooser immediately. It only prevents work not
/// yet started; the original native producer keeps its physical lease.
final class NativeSelectionLoading: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
}

struct NativeSelectionSample {
    let x: Int
    let y: Int
    let red: Int
    let green: Int
    let blue: Int
    let image: CGImage
    var hex: String { String(format: "#%02X%02X%02X", red, green, blue) }
}

final class NativeSelectionPixels: @unchecked Sendable {
    let displays: [NativeSelectionDisplay]
    init(displays: [NativeSelectionDisplay]) { self.displays = displays }

    func display(in frame: CGRect) -> NativeSelectionDisplay? { displays.first { $0.appKitFrame == frame } }

    func issue(in rectangle: CGRect) -> String? {
        let relevant = displays.filter { $0.quartzFrame.intersects(rectangle) }
        if let missing = relevant.first(where: { $0.image == nil }) {
            let subject = missing.displayID.map { "Display \($0)" } ?? "Unconfirmed display"
            return "\(subject): \(missing.issue ?? "the original screen pixels are unavailable")"
        }
        return relevant.contains { $0.image != nil } ? nil : "The selected region has no captured display pixels."
    }

    func geometry(in rectangle: CGRect) -> (width: Int, height: Int, scale: CGFloat) {
        let scale = displays.filter { $0.image != nil && $0.quartzFrame.intersects(rectangle) }.map(\.scale).max() ?? 1
        return (Int(ceil(rectangle.width * scale)), Int(ceil(rectangle.height * scale)), scale)
    }

    /// Preview and output consume the same images. The context clips each
    /// source to the selection, avoiding another full-display pixel copy.
    func compose(_ rectangle: CGRect) throws -> (image: CGImage, scale: Double, engine: String) {
        guard NativeCaptureGeometry.isValid(rectangle) else {
            throw NativeScreenSelectionError(code: "invalid_argument", message: "the selected region must have finite coordinates and positive dimensions")
        }
        if let issue = issue(in: rectangle) { throw NativeScreenSelectionError(code: "display_capture_unavailable", message: issue) }
        let geometry = geometry(in: rectangle)
        guard NativeImageLimits.permits(width: Double(geometry.width), height: Double(geometry.height)),
              let context = CGContext(data: nil, width: geometry.width, height: geometry.height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw NativeScreenSelectionError(code: "image_too_large", message: "the selected image exceeds the host image allocation limit")
        }
        context.interpolationQuality = .none
        for display in displays where display.quartzFrame.intersects(rectangle) {
            guard let image = display.image else { continue } // The exact missing-source check above owns completion.
            let frame = display.quartzFrame
            let destination = CGRect(x: (frame.minX - rectangle.minX) * geometry.scale,
                y: (rectangle.maxY - frame.maxY) * geometry.scale,
                width: frame.width * geometry.scale, height: frame.height * geometry.scale)
            context.draw(image, in: destination)
        }
        guard let image = context.makeImage() else {
            throw NativeScreenSelectionError(code: "capture_failed", message: "the original frozen image could not be composed")
        }
        let engines = Set(displays.filter { $0.quartzFrame.intersects(rectangle) }.map(\.engine))
        return (image, Double(geometry.scale), engines.count == 1 ? engines.first! : "frozen-display-composite")
    }

    func sample(at point: CGPoint, in display: NativeSelectionDisplay) -> NativeSelectionSample? {
        guard display.appKitFrame.contains(point), let image = display.image else { return nil }
        let x = min(image.width - 1, max(0, Int(floor((point.x - display.appKitFrame.minX) * CGFloat(image.width) / display.appKitFrame.width))))
        let y = min(image.height - 1, max(0, Int(floor((display.appKitFrame.maxY - point.y) * CGFloat(image.height) / display.appKitFrame.height))))
        guard let pixel = image.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)) else { return nil }
        var rgba = [UInt8](repeating: 0, count: 4)
        let read = rgba.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            context.draw(pixel, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            return true
        }
        guard read else { return nil }
        return NativeSelectionSample(x: x, y: y, red: Int(rgba[0]), green: Int(rgba[1]), blue: Int(rgba[2]), image: image)
    }
}
