import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import AgentMuxNativeMacOSCore

/// All rectangles crossing this boundary use global Quartz display points.
/// The primary display's upper-left is (0, 0); other displays may have negative origins.
enum NativeDesktopOperations {
    static func capture(_ params: [String: JSONValue]) -> [String: Any] {
        do {
            let mode = params["mode"]?.string ?? "selection"
            if let editing = params["allowEditing"], mode != "selection" || editing.bool == nil {
                throw ProviderError.coded("invalid_argument", "allowEditing must be a boolean on a selection request")
            }
            let rect: CGRect
            if mode == "selection" {
                return try NativeSelectionCaptureLease.shared.withCapture { ownership in
                    let allowEditing = params["allowEditing"]?.bool == true
                    let selection = try NativeSelectionRequest.run(allowEditing: allowEditing)
                    guard let selection else { return ["state": "cancelled"] }
                    var result = try capturedRectangle(selection.rectangle, ownership: ownership)
                    if allowEditing { result["completionAction"] = selection.completionAction.rawValue }
                    return result
                }
            } else if mode == "rect" {
                guard case let .object(values)? = params["rect"],
                      let x = values["x"]?.number, let y = values["y"]?.number,
                      let width = values["width"]?.number, let height = values["height"]?.number else {
                    throw ProviderError.coded("invalid_argument", "rect requires x, y, width and height in Quartz points")
                }
                rect = CGRect(x: x, y: y, width: width, height: height)
            } else if mode == "display" {
                let displayID = try displayIDArgument(params["displayId"])
                guard CGDisplayIsActive(displayID) != 0 else {
                    throw ProviderError.coded("display_not_found", "the requested display is not active")
                }
                rect = CGDisplayBounds(displayID)
            } else if mode == "window" {
                return try captureWindow(params)
            } else {
                throw ProviderError.coded("invalid_argument", "mode must be selection, display, rect or window")
            }
            return try capturedRectangle(rect)
        } catch {
            let captureError: Error
            if error is NativeSelectionCaptureLease.Failure {
                captureError = ProviderError.coded("capture_busy", "the original selection capture is still producing its image")
            } else { captureError = (error as? NativeScreenSelectionError).map { ProviderError.coded($0.code, $0.message) } ?? error }
            return ["state": "failed", "error": nativeErrorPayload(captureError)]
        }
    }

    private static func capturedRectangle(_ rect: CGRect, ownership: NativeSelectionCaptureLease.Ownership? = nil) throws -> [String: Any] {
        guard NativeCaptureGeometry.isValid(rect) else {
            throw ProviderError.coded("invalid_argument", "capture rectangle must have finite coordinates and positive dimensions")
        }
        let capture = try captureRect(rect, ownership: ownership)
        return ["state": "captured", "screenshot": try png(capture.image, scale: capture.scale), "engine": capture.engine,
                "selectionRect": renderRect(rect)]
    }

    static func listDisplays() -> [String: Any] {
        onMain {
            let displays = NSScreen.screens.compactMap { screen -> [String: Any]? in
                guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
                let displayID = number.uint32Value
                var value: [String: Any] = renderRect(CGDisplayBounds(displayID))
                value["id"] = displayID
                value["scale"] = screen.backingScaleFactor
                value["isMain"] = displayID == CGMainDisplayID()
                return value
            }
            return ["displays": displays]
        }
    }

    static func permissionStatus() -> [String: Any] {
        ["accessibility": AXIsProcessTrusted() ? "granted" : "not-granted",
         "screenshots": CGPreflightScreenCaptureAccess() ? "granted" : "not-granted",
         "source": "macOS-preflight", "authoritativeForOperation": false]
    }

    static func clipboardRead(_ params: [String: JSONValue]) throws -> [String: Any] {
        let format = try clipboardFormat(params)
        return try withNativeClipboard { try onMain {
            let clipboard = NSPasteboard.general
            let value: String?
            if format == "text" {
                value = clipboard.string(forType: .string)
            } else if let data = clipboard.data(forType: .png) {
                _ = try validatedPNG(data)
                value = data.base64EncodedString()
            } else {
                let supported = Set(CGImageSourceCopyTypeIdentifiers() as? [String] ?? [])
                let type = clipboard.types?.first { supported.contains($0.rawValue) }
                if let type, let data = clipboard.data(forType: type) {
                    value = try pngData(validatedRaster(data)).base64EncodedString()
                } else {
                    value = nil
                }
            }
            return ["format": format, "data": value as Any? ?? NSNull(), "state": value == nil ? "empty" : "read", "changeCount": clipboard.changeCount]
        } }
    }

    static func clipboardWrite(_ params: [String: JSONValue]) throws -> [String: Any] {
        let format = try clipboardFormat(params)
        guard let value = params["data"]?.string else {
            throw ProviderError.coded("invalid_argument", "clipboard write requires data")
        }
        let content: Data
        if format == "png" {
            guard value.utf8.count <= 24 * 1024 * 1024, let decoded = Data(base64Encoded: value) else { throw ProviderError.coded("invalid_argument", "PNG must be base64 encoded") }
            _ = try validatedPNG(decoded)
            content = decoded
        } else {
            content = Data(value.utf8)
        }
        return try withNativeClipboard { try onMain {
            let clipboard = NSPasteboard.general
            let item = NSPasteboardItem()
            guard item.setData(content, forType: format == "text" ? .string : .png) else {
                throw ProviderError.coded("clipboard_write_failed", "could not prepare clipboard content; previous clipboard retained")
            }
            clipboard.clearContents()
            guard clipboard.writeObjects([item]) else {
                throw ProviderError.coded("clipboard_write_failed", "macOS did not confirm the clipboard write")
            }
            return ["state": "written", "format": format, "changeCount": clipboard.changeCount, "byteLength": content.count]
        } }
    }

    private static func clipboardFormat(_ params: [String: JSONValue]) throws -> String {
        guard let format = params["format"]?.string, format == "text" || format == "png" else {
            throw ProviderError.coded("invalid_argument", "clipboard format must be text or png")
        }
        return format
    }

    private static func validatedPNG(_ data: Data) throws -> CGImage {
        let magic: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]
        guard data.count <= NativeImageLimits.maxPNGBytes, data.starts(with: magic),
              let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight as String] as? NSNumber,
              NativeImageLimits.permits(width: width.doubleValue, height: height.doubleValue),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw ProviderError.coded("invalid_png", "clipboard image is not a readable single PNG")
        }
        return image
    }

    private static func validatedRaster(_ data: Data) throws -> CGImage {
        guard data.count <= NativeImageLimits.maxRasterSourceBytes else {
            throw ProviderError.coded("image_too_large", "clipboard raster source exceeds the native per-image byte budget")
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight as String] as? NSNumber else {
            throw ProviderError.coded("image_decode_failed", "macOS did not provide readable clipboard raster metadata")
        }
        guard NativeImageLimits.permits(width: width.doubleValue, height: height.doubleValue) else {
            throw ProviderError.coded("image_too_large", "clipboard raster pixels exceed the native per-image allocation budget")
        }
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache as String: false] as CFDictionary) else {
            throw ProviderError.coded("image_decode_failed", "macOS could not decode the bounded clipboard raster")
        }
        return image
    }

    private static func displayIDArgument(_ value: JSONValue?) throws -> CGDirectDisplayID {
        guard let number = value?.number, number.isFinite, number.rounded() == number,
              number > 0, number <= Double(UInt32.max) else {
            throw ProviderError.coded("invalid_argument", "displayId must be a discovered CGDirectDisplayID")
        }
        return CGDirectDisplayID(number)
    }

    private static func captureWindow(_ params: [String: JSONValue]) throws -> [String: Any] {
        let windowID = try displayIDArgument(params["windowId"])
        guard let pidString = params["app"]?.string, pidString.hasPrefix("pid:"),
              let pid = pid_t(pidString.dropFirst(4)), pid > 1,
              let expectedStart = params["processStartedAt"]?.number,
              let app = NSRunningApplication(processIdentifier: pid),
              let start = app.launchDate, abs(start.timeIntervalSince1970 * 1000 - expectedStart) < 0.01,
              let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
              let window = windows.first, (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              let boundsDictionary = window[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary) else {
            throw ProviderError.coded("window_stale", "windowId and processStartedAt do not identify the original live window")
        }
        let capture = try windowPixels(windowID: windowID, bounds: bounds, pid: pid)
        return ["state": "captured", "screenshot": try png(capture.image, scale: Double(capture.image.width) / bounds.width), "engine": capture.engine, "selectionRect": renderRect(bounds)]
    }

    static func windowPixels(windowID: CGWindowID, bounds: CGRect, pid: pid_t) throws -> CapturedImage {
        let image: CGImage?
        let engine: String
        if #available(macOS 14.0, *) {
            image = try BlockingAsync.run(timeout: 10) {
                let content = try await SCShareableContent.current
                guard let window = content.windows.first(where: { $0.windowID == windowID && $0.owningApplication?.processID == pid }) else {
                    throw ProviderError.coded("window_stale", "the exact requested window disappeared")
                }
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let configuration = SCStreamConfiguration()
                let scale = displayScale(for: bounds)
                guard NativeImageLimits.permits(width: ceil(bounds.width * scale), height: ceil(bounds.height * scale)) else {
                    throw ProviderError.coded("image_too_large", "window pixels exceed the host image allocation limit")
                }
                configuration.width = Int(ceil(bounds.width * scale))
                configuration.height = Int(ceil(bounds.height * scale))
                configuration.showsCursor = false
                configuration.ignoreShadowsSingleWindow = true
                return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            }
            engine = "screenCaptureKit"
        } else {
            let scale = displayScale(for: bounds)
            guard NativeImageLimits.permits(width: ceil(bounds.width * scale), height: ceil(bounds.height * scale)) else {
                throw ProviderError.coded("image_too_large", "window pixels exceed the host image allocation limit")
            }
            image = CGWindowListCreateImage(.null, .optionIncludingWindow, windowID, [.boundsIgnoreFraming, .bestResolution])
            engine = "coreGraphics"
        }
        guard let image else { throw ProviderError.coded("capture_failed", "macOS returned no image for the exact requested window") }
        return CapturedImage(image: image, engine: engine)
    }

    private static func captureRect(_ rect: CGRect, ownership: NativeSelectionCaptureLease.Ownership? = nil) throws -> (image: CGImage, scale: Double, engine: String) {
        if #available(macOS 14.0, *) { return try captureRectWithScreenCaptureKit(rect, ownership: ownership) }
        let scale = displayScale(for: rect)
        guard NativeImageLimits.permits(width: ceil(rect.width * scale), height: ceil(rect.height * scale)) else {
            throw ProviderError.coded("image_too_large", "rectangle pixels exceed the host image allocation limit")
        }
        guard let image = CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) else {
            throw ProviderError.coded("capture_failed", "macOS did not return an image for this rectangle")
        }
        return (image, Double(image.width) / rect.width, "coreGraphics")
    }

    @available(macOS 14.0, *)
    private static func captureRectWithScreenCaptureKit(_ rect: CGRect, ownership: NativeSelectionCaptureLease.Ownership? = nil) throws -> (image: CGImage, scale: Double, engine: String) {
        try BlockingAsync.run(timeout: 10) {
            // A timed-out observer can return while SCK still owns pixels.
            // Release this selection only after the actual producer body exits.
            defer { withExtendedLifetime(ownership) {} }
            let content = try await SCShareableContent.current
            let displays = content.displays.filter { $0.frame.intersects(rect) }
            guard !displays.isEmpty else { throw ProviderError.coded("display_not_found", "capture rectangle does not intersect an active display") }
            let scale = displays.map { displayScale(for: $0.frame) }.max() ?? 1
            guard NativeImageLimits.permits(width: ceil(rect.width * scale), height: ceil(rect.height * scale)) else {
                throw ProviderError.coded("image_too_large", "rectangle pixels exceed the host image allocation limit")
            }
            let width = Int(ceil(rect.width * scale)), height = Int(ceil(rect.height * scale))
            guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
                throw ProviderError.coded("capture_failed", "could not allocate the requested capture image")
            }
            for display in displays {
                let part = display.frame.intersection(rect)
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let configuration = SCStreamConfiguration()
                configuration.sourceRect = part.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
                configuration.width = Int(ceil(part.width * scale))
                configuration.height = Int(ceil(part.height * scale))
                configuration.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                let destination = CGRect(x: (part.minX - rect.minX) * scale, y: (rect.maxY - part.maxY) * scale,
                                         width: part.width * scale, height: part.height * scale)
                context.draw(image, in: destination)
            }
            guard let image = context.makeImage() else { throw ProviderError.coded("capture_failed", "could not encode the captured displays") }
            return (image, scale, "screenCaptureKit")
        }
    }

    private static func displayScale(for rect: CGRect) -> Double {
        onMain {
            guard let screen = NSScreen.screens.first(where: { screen in
                guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
                return CGDisplayBounds(id.uint32Value).intersects(rect)
            }) else { return 1 }
            return Double(screen.backingScaleFactor)
        }
    }

    private static func pngData(_ image: CGImage) throws -> Data {
        guard NativeImageLimits.permits(width: Double(image.width), height: Double(image.height)) else {
            throw ProviderError.coded("image_too_large", "native pixels exceed the host image allocation limit")
        }
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]),
              data.count <= NativeImageLimits.maxPNGBytes else {
            throw ProviderError.coded("capture_failed", "could not encode native image as PNG")
        }
        return data
    }

    private static func png(_ image: CGImage, scale: Double) throws -> [String: Any] {
        ["data": try pngData(image).base64EncodedString(), "format": "png", "width": image.width, "height": image.height, "scale": scale]
    }

    private static func renderRect(_ rect: CGRect) -> [String: Double] {
        ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
    }
}

private let nativeClipboardLock = NSLock()
func withNativeClipboard<T>(_ body: () throws -> T) rethrows -> T {
    nativeClipboardLock.lock()
    defer { nativeClipboardLock.unlock() }
    return try body()
}

func onMain<T>(_ body: () throws -> T) rethrows -> T {
    if Thread.isMainThread { return try body() }
    return try DispatchQueue.main.sync(execute: body)
}
