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
            let mode = params["mode"]?.string
            let rect: CGRect
            if mode == "rect" {
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
                throw ProviderError.coded("invalid_argument", "mode must be display, rect or window")
            }
            return try capturedRectangle(rect)
        } catch {
            return ["state": "failed", "error": nativeErrorPayload(error)]
        }
    }

    private static func capturedRectangle(_ rect: CGRect) throws -> [String: Any] {
        guard NativeCaptureGeometry.isValid(rect) else {
            throw ProviderError.coded("invalid_argument", "capture rectangle must have finite coordinates and positive dimensions")
        }
        let capture = try captureRect(rect)
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
              let start = NativeProcessStart.milliseconds(pid: pid), abs(start - expectedStart) < 0.01,
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

    /// Every display's frozen pixels from one physical grab each, so a host can
    /// show and crop exactly what was on screen. A display that cannot be
    /// captured carries its `issue`; the other displays remain usable. Each
    /// display also lists the normal windows over it, front to back, read once
    /// beside the grabs. Native PID filters remove the helper and, on request,
    /// every capturable host window without hiding or moving either process's UI.
    static func captureDisplays(hostPID: pid_t, includeHostWindows: Bool = false) throws -> [String: Any] {
        do {
            return try NativeDisplayCaptureLease.shared.withCapture { ownership in
                let totalStarted = DispatchTime.now().uptimeNanoseconds
                let capturedAt = Date().timeIntervalSince1970 * 1000
                // `safeTop` is the band a camera housing covers at the display's top, in points; zero without one.
                let screens: [(id: CGDirectDisplayID, scale: CGFloat, safeTop: CGFloat)] = onMain {
                    NSScreen.screens.compactMap { screen in
                        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber).map { ($0.uint32Value, screen.backingScaleFactor, screen.safeAreaInsets.top) }
                    }
                }
                guard !screens.isEmpty else { throw ProviderError.coded("display_not_found", "macOS reports no active display") }
                let excludedOwners: Set<pid_t> = includeHostWindows ? [getpid()] : [getpid(), hostPID]
                let windowListStarted = DispatchTime.now().uptimeNanoseconds
                // One window-server snapshot supplies both normal-layer metadata and
                // host visibility on every display, including non-normal panels.
                let allWindows = visibleWindows(excludingOwners: [], allLayers: true)
                let windowListMs = captureMilliseconds(since: windowListStarted)
                let windows = allWindows.filter { $0.normalLayer && !excludedOwners.contains($0.pid) }
                let hostWindows = allWindows.filter { $0.pid == hostPID }
                let pixels: (CGDirectDisplayID, CGRect, CGFloat) throws -> CapturedImage
                var contentMs = 0.0
                if #available(macOS 14.0, *) {
                    // One ScreenCaptureKit enumeration serves every display's grab and
                    // the exact same PID-derived exclusion list on every display.
                    let contentStarted = DispatchTime.now().uptimeNanoseconds
                    let content = Result {
                        let shareable = try BlockingAsync.run(timeout: 10) { try await SCShareableContent.current }
                        let excluded = shareable.windows.filter { window in
                            guard let pid = window.owningApplication?.processID else { return false }
                            return excludedOwners.contains(pid)
                        }
                        return (shareable: shareable, excludedWindows: excluded)
                    }
                    contentMs = captureMilliseconds(since: contentStarted)
                    pixels = { id, frame, scale in
                        let resolved = try content.get()
                        return try displayPixels(id, frame: frame, scale: scale, content: resolved.shareable,
                            excludingWindows: resolved.excludedWindows, ownership: ownership)
                    }
                } else {
                    pixels = { _, frame, scale in
                        // CoreGraphics cannot subtract one process from a display grab.
                        // Never label pixels that still contain the host as excluded.
                        if !includeHostWindows && hostWindows.contains(where: { $0.frame.intersects(frame) }) {
                            throw ProviderError.coded("host_window_exclusion_unavailable", "CoreGraphics cannot exclude the visible host from this display")
                        }
                        return try coreGraphicsDisplayPixels(frame, scale: scale)
                    }
                }
                // Every display's pixels share one response frame. The identity envelope and
                // all displays' metadata stay far below the reserve.
                var remainingFrameBytes = NativeNDJSONReader.maxFrameBytes - 64 * 1024
                let displays = screens.map { screen -> [String: Any] in
                    let displayStarted = DispatchTime.now().uptimeNanoseconds
                    var captureMs = 0.0, pngMs = 0.0, base64Ms = 0.0
                    let frame = CGDisplayBounds(screen.id)
                    var entry: [String: Any] = ["displayId": screen.id, "frame": renderRect(frame), "scale": screen.scale, "safeTop": screen.safeTop,
                        "windows": windows.filter { $0.frame.intersects(frame) }.map(\.entry)]
                    do {
                        let captureStarted = DispatchTime.now().uptimeNanoseconds
                        let capture = try pixels(screen.id, frame, screen.scale)
                        captureMs = captureMilliseconds(since: captureStarted)
                        let pngStarted = DispatchTime.now().uptimeNanoseconds
                        let png = try pngData(capture.image)
                        pngMs = captureMilliseconds(since: pngStarted)
                        let encodedBytes = (png.count + 2) / 3 * 4
                        guard encodedBytes <= remainingFrameBytes else {
                            throw ProviderError.coded("image_too_large", "this display's pixels do not fit one response beside the displays listed before it")
                        }
                        let base64Started = DispatchTime.now().uptimeNanoseconds
                        let encoded = png.base64EncodedString()
                        base64Ms = captureMilliseconds(since: base64Started)
                        remainingFrameBytes -= encodedBytes
                        entry["png"] = encoded
                        entry["width"] = capture.image.width
                        entry["height"] = capture.image.height
                        entry["engine"] = capture.engine
                    } catch {
                        let payload = nativeErrorPayload(error)
                        entry["issue"] = "\(payload["code"] ?? "capture_failed"): \(payload["message"] ?? "display pixels are unavailable")"
                    }
                    entry["timing"] = ["captureMs": captureMs, "pngMs": pngMs, "base64Ms": base64Ms,
                        "totalMs": captureMilliseconds(since: displayStarted)]
                    return entry
                }
                guard displays.contains(where: { $0["png"] != nil }) else {
                    throw ProviderError.coded("display_capture_unavailable", displays.compactMap { $0["issue"] as? String }.joined(separator: "\n"))
                }
                return ["state": "captured", "capturedAt": capturedAt, "displays": displays,
                    "timing": ["contentMs": contentMs, "windowListMs": windowListMs, "totalMs": captureMilliseconds(since: totalStarted)]]
            }
        } catch is NativeDisplayCaptureLease.Failure {
            throw ProviderError.coded("capture_busy", "an earlier display capture is still producing its pixels")
        }
    }

    /// On-screen windows in the window server's front-to-back order, with global
    /// Quartz frames. Metadata keeps normal layer 0 only. The same one-shot list
    /// may retain other layers solely to establish whether exclusion is possible.
    private static func visibleWindows(excludingOwners owners: Set<pid_t>, allLayers: Bool = false) -> [(pid: pid_t, frame: CGRect, normalLayer: Bool, entry: [String: Any])] {
        guard let infos = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else { return [] }
        return infos.compactMap { info in
            guard let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, !owners.contains(pid),
                  ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,
                  (info[kCGWindowSharingState as String] as? NSNumber)?.intValue != 0,
                  let number = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds), frame.width > 0, frame.height > 0
            else { return nil }
            let normalLayer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
            guard allLayers || normalLayer else { return nil }
            var entry: [String: Any] = ["windowId": number, "frame": renderRect(frame)]
            if let owner = info[kCGWindowOwnerName as String] as? String { entry["owner"] = owner }
            return (pid, frame, normalLayer, entry)
        }
    }

    private static func captureMilliseconds(since start: UInt64) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }

    /// One grab of one exact display. The asynchronous producer keeps
    /// `ownership` until it actually returns, so a timed-out observer cannot
    /// let a second physical grab start while ScreenCaptureKit still runs.
    @available(macOS 14.0, *)
    private static func displayPixels(_ id: CGDirectDisplayID, frame: CGRect, scale: CGFloat, content: SCShareableContent,
        excludingWindows: [SCWindow], ownership: NativeDisplayCaptureLease.Ownership) throws -> CapturedImage {
        let width = ceil(frame.width * scale), height = ceil(frame.height * scale)
        guard NativeImageLimits.permits(width: width, height: height) else {
            throw ProviderError.coded("image_too_large", "display pixels exceed the host image allocation limit")
        }
        guard let match = content.displays.first(where: { $0.displayID == id }) else {
            throw ProviderError.coded("display_not_found", "the exact display disappeared before its pixels were captured")
        }
        guard match.frame == frame else {
            throw ProviderError.coded("display_configuration_changed", "the display bounds changed before its pixels were captured")
        }
        // SCDisplay and SCWindow are immutable descriptions the producer only reads; the SDK does not mark them Sendable.
        nonisolated(unsafe) let display = match
        nonisolated(unsafe) let exclusions = excludingWindows
        let image = try BlockingAsync.run(timeout: 10) {
            defer { withExtendedLifetime(ownership) {} }
            let configuration = SCStreamConfiguration()
            configuration.width = Int(width)
            configuration.height = Int(height)
            configuration.showsCursor = false
            return try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: exclusions),
                configuration: configuration)
        }
        return CapturedImage(image: image, engine: "screenCaptureKit")
    }

    private static func coreGraphicsDisplayPixels(_ frame: CGRect, scale: CGFloat) throws -> CapturedImage {
        guard NativeImageLimits.permits(width: ceil(frame.width * scale), height: ceil(frame.height * scale)) else {
            throw ProviderError.coded("image_too_large", "display pixels exceed the host image allocation limit")
        }
        guard let image = CGWindowListCreateImage(frame, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) else {
            throw ProviderError.coded("capture_failed", "macOS did not return pixels for this display")
        }
        return CapturedImage(image: image, engine: "coreGraphics")
    }

    private static func captureRect(_ rect: CGRect) throws -> (image: CGImage, scale: Double, engine: String) {
        if #available(macOS 14.0, *) { return try captureRectWithScreenCaptureKit(rect) }
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
    private static func captureRectWithScreenCaptureKit(_ rect: CGRect) throws -> (image: CGImage, scale: Double, engine: String) {
        try BlockingAsync.run(timeout: 10) {
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
