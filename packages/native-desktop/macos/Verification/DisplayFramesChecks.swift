import Foundation
import CoreGraphics
import AgentMuxNativeMacOSCore

// The exact production capture dispatch, captureDisplays/displayPixels and
// BlockingAsync source is inserted. Only the OS display/window lists,
// ScreenCaptureKit, CoreGraphics, PNG encoding and exact-source grabs are
// controlled, so each display's grab, issue, exclusion and timing is observable.
private enum NativeDesktopOperations {
    /* PRODUCTION_CAPTURE_DISPATCH */
    /* PRODUCTION_DISPLAY_FRAMES */
    static func displayIDArgument(_ value: JSONValue?) throws -> CGDirectDisplayID { CGDirectDisplayID(value?.number ?? 0) }
    static func captureWindow(_ params: [String: JSONValue]) throws -> [String: Any] { Controlled.shared.sourceCaptured(); return ["state": "captured"] }
    static func capturedRectangle(_ rect: CGRect) throws -> [String: Any] { Controlled.shared.sourceCaptured(); return ["state": "captured"] }
    static func pngData(_ image: CGImage) throws -> Data {
        if Controlled.shared.encoded() { throw ProviderError.coded("controlled_png_failed", "the controlled PNG encoder failed after its delay") }
        return Controlled.shared.pngBytes.map { Data(count: $0) } ?? Data("png-\(image.width)x\(image.height)".utf8)
    }
    static func renderRect(_ rect: CGRect) -> [String: Double] { ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height] }
}

private func displayRequest(_ params: [String: JSONValue]) throws -> [String: Any] {
    switch "captureDisplays" {
    /* PRODUCTION_DISPLAY_REQUEST */
    default: throw ProviderError.coded("fixture_unexpected", "not a display capture request")
    }
}

/* PRODUCTION_BLOCKING_ASYNC */
/* PRODUCTION_RESPONSE_WRITER */

private enum ProviderError: Error { case coded(String, String) }
private enum JSONValue {
    case string(String), number(Double), bool(Bool), object([String: JSONValue])
    var string: String? { if case let .string(value) = self { return value }; return nil }
    var number: Double? { if case let .number(value) = self { return value }; return nil }
    var bool: Bool? { if case let .bool(value) = self { return value }; return nil }
}
private struct CapturedImage { let image: CGImage; let engine: String }
private func nativeErrorPayload(_ error: Error) -> [String: String] {
    if case let ProviderError.coded(code, message) = error { return ["code": code, "message": message] }
    return ["code": "fixture_unexpected", "message": String(describing: error)]
}
private func onMain<T>(_ body: () throws -> T) rethrows -> T { try body() }

// Display 1 is the 2x main display, display 2 a 1x display to its left (negative
// Quartz origin), display 3 one ScreenCaptureKit no longer lists, display 4 one
// ScreenCaptureKit reports with a frame that no longer matches its bounds.
private let bounds: [CGDirectDisplayID: CGRect] = [
    1: CGRect(x: 0, y: 0, width: 400, height: 300),
    2: CGRect(x: -200, y: -50, width: 200, height: 100),
    3: CGRect(x: 400, y: 0, width: 100, height: 100),
    4: CGRect(x: 0, y: 300, width: 100, height: 100),
]
private func CGDisplayBounds(_ display: CGDirectDisplayID) -> CGRect { bounds[display] ?? .null }
private func CGMainDisplayID() -> CGDirectDisplayID { 1 }
private func CGDisplayIsActive(_ display: CGDirectDisplayID) -> boolean_t { bounds[display] == nil ? 0 : 1 }
private func CGWindowListCreateImage(_ rect: CGRect, _ option: Int, _ window: Int, _ image: [Int]) -> CGImage? { Controlled.shared.coreGraphicsPixels(rect) }
private func CGWindowListCopyWindowInfo(_ option: Int, _ window: Int) -> CFArray? {
    guard let listed = Controlled.shared.listedWindows() else { return nil }
    return listed as CFArray
}
// The window server's on-screen list, front to back.
private let hostPID: pid_t = 4242
private func window(_ id: UInt32, pid: pid_t, _ frame: CGRect, layer: Int = 0, alpha: Double = 1, sharing: Int = 1, owner: String = "Editor") -> [String: Any] {
    [kCGWindowNumber as String: NSNumber(value: id), kCGWindowOwnerPID as String: NSNumber(value: pid), kCGWindowLayer as String: NSNumber(value: layer),
     kCGWindowAlpha as String: NSNumber(value: alpha), kCGWindowSharingState as String: NSNumber(value: sharing), kCGWindowOwnerName as String: owner,
     kCGWindowBounds as String: frame.dictionaryRepresentation]
}
private func windowList() -> [[String: Any]] { [
    window(11, pid: 500, CGRect(x: 10, y: 10, width: 100, height: 80)),
    window(12, pid: getpid(), CGRect(x: 0, y: 0, width: 50, height: 50)),
    window(13, pid: hostPID, CGRect(x: 20, y: 20, width: 60, height: 60)),
    window(14, pid: 501, CGRect(x: 0, y: 0, width: 400, height: 24), layer: 25),
    window(15, pid: 502, CGRect(x: -150, y: -40, width: 300, height: 120), owner: "Browser"),
    window(16, pid: 503, CGRect(x: 2000, y: 2000, width: 100, height: 100)),
    window(17, pid: 504, CGRect(x: 40, y: 40, width: 100, height: 100), alpha: 0),
    window(18, pid: 505, CGRect(x: 30, y: 30, width: 300, height: 200), owner: "Finder"),
    window(19, pid: 506, CGRect(x: 50, y: 50, width: 100, height: 100), sharing: 0),
    window(20, pid: hostPID, CGRect(x: 30, y: 100, width: 80, height: 70), layer: 25, owner: ""),
    window(21, pid: getpid(), CGRect(x: 5, y: 5, width: 40, height: 40), layer: 25, owner: ""),
    window(22, pid: 507, CGRect(x: 90, y: 90, width: 80, height: 70), layer: 25, owner: "Panel"),
] }
private let kCGNullWindowID = 0
private extension Int { static let optionOnScreenOnly = 0, bestResolution = 0 }
private struct NSDeviceDescriptionKey: Hashable { let rawValue: String; init(_ value: String) { rawValue = value } }
private struct NSEdgeInsets { var top: CGFloat, left: CGFloat, bottom: CGFloat, right: CGFloat }
private struct NSScreen {
    let id: CGDirectDisplayID?
    let backingScaleFactor: CGFloat
    var safeAreaInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    var deviceDescription: [NSDeviceDescriptionKey: Any] { id.map { [NSDeviceDescriptionKey("NSScreenNumber"): NSNumber(value: $0)] } ?? [:] }
    static var screens: [NSScreen] { Controlled.shared.screens }
}

private struct SCDisplay: Sendable { let displayID: CGDirectDisplayID; let frame: CGRect }
private struct SCRunningApplication: Sendable { let processID: pid_t }
private struct SCWindow: Sendable { let windowID: UInt32; let owningApplication: SCRunningApplication?; let windowLayer: Int }
private func scWindow(_ id: UInt32, _ pid: pid_t, layer: Int = 0) -> SCWindow { SCWindow(windowID: id, owningApplication: SCRunningApplication(processID: pid), windowLayer: layer) }
private struct SCShareableContent: Sendable {
    let displays = [SCDisplay(displayID: 1, frame: bounds[1]!), SCDisplay(displayID: 2, frame: bounds[2]!),
        SCDisplay(displayID: 4, frame: CGRect(x: 0, y: 300, width: 120, height: 100))]
    let windows = [
        scWindow(11, 500), scWindow(12, getpid()), scWindow(21, getpid(), layer: 25),
        scWindow(13, hostPID), scWindow(20, hostPID, layer: 25), scWindow(14, 501, layer: 25),
        scWindow(15, 502), scWindow(22, 507, layer: 25),
    ]
    static var current: SCShareableContent { get async throws { Controlled.shared.enumerated(); return SCShareableContent() } }
}
private final class SCContentFilter: @unchecked Sendable {
    let displayID: CGDirectDisplayID
    let excludedWindowIDs: [UInt32]
    init(display: SCDisplay, excludingWindows: [SCWindow]) {
        displayID = display.displayID
        excludedWindowIDs = excludingWindows.map(\.windowID).sorted()
    }
}
private final class SCStreamConfiguration: @unchecked Sendable { var width = 0, height = 0; var showsCursor = true }
private enum SCScreenshotManager {
    static func captureImage(contentFilter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
        let number = Controlled.shared.started(contentFilter.displayID, cursor: configuration.showsCursor, excludedWindowIDs: contentFilter.excludedWindowIDs)
        defer { Controlled.shared.returned(number) }
        // Each grab takes measurable time, so a timestamp taken after the grabs is distinguishable.
        try await Task.sleep(nanoseconds: 5_000_000)
        if Controlled.shared.failingDisplay == contentFilter.displayID { throw ProviderError.coded("controlled_capture_failed", "the controlled display grab failed after its delay") }
        if Controlled.shared.holdFirst, number == 1 { return try await withCheckedThrowingContinuation { Controlled.shared.suspend($0) } }
        return try pixels(width: configuration.width, height: configuration.height)
    }
}
private func pixels(width: Int, height: Int) throws -> CGImage {
    // A grab past the host limits would allocate gigabytes; the controlled service refuses it instead.
    guard width <= NativeImageLimits.maxDimension, height <= NativeImageLimits.maxDimension else {
        throw ProviderError.coded("fixture_oversized_grab", "the controlled service refused an oversized grab")
    }
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
        let image = context.makeImage() else { throw ProviderError.coded("fixture_allocation", "could not create controlled pixels") }
    return image
}

private final class Controlled: @unchecked Sendable {
    static let shared = Controlled()
    let suspended = DispatchSemaphore(value: 0), managerReturned = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CGImage, Error>?
    private var grabs: [CGDirectDisplayID] = [], exclusions: [[UInt32]] = [], cursors = 0, encodes = 0, enumerations = 0, windowLists = 0, firstReturned = false
    private var firstGrabAt: Double?
    var screens: [NSScreen] = []
    var holdFirst = false
    var pngBytes: Int?
    var failingDisplay: CGDirectDisplayID?
    var windowListAvailable = true
    private var pngFailures = 0
    func started(_ id: CGDirectDisplayID, cursor: Bool, excludedWindowIDs: [UInt32]) -> Int {
        lock.lock(); defer { lock.unlock() }
        grabs.append(id); exclusions.append(excludedWindowIDs); if cursor { cursors += 1 }
        if grabs.count == 1 { firstGrabAt = Date().timeIntervalSince1970 * 1000 }
        return grabs.count
    }
    func coreGraphicsPixels(_ rect: CGRect) -> CGImage? {
        let id = bounds.first(where: { $0.value == rect })?.key ?? 0
        _ = started(id, cursor: false, excludedWindowIDs: [])
        return try? pixels(width: Int(rect.width), height: Int(rect.height))
    }
    func enumerated() { lock.lock(); enumerations += 1; lock.unlock() }
    func listedWindows() -> [[String: Any]]? { lock.lock(); windowLists += 1; let available = windowListAvailable; lock.unlock(); return available ? windowList() : nil }
    var windowListings: Int { lock.lock(); defer { lock.unlock() }; return windowLists }
    private(set) var sources = 0
    func sourceCaptured() { lock.lock(); sources += 1; lock.unlock() }
    func failNextPNG() { lock.lock(); pngFailures = 1; lock.unlock() }
    func encoded() -> Bool {
        lock.lock(); encodes += 1; let fail = pngFailures > 0; if fail { pngFailures -= 1 }; lock.unlock()
        if fail { Thread.sleep(forTimeInterval: 0.005) }
        return fail
    }
    func suspend(_ value: CheckedContinuation<CGImage, Error>) { lock.lock(); continuation = value; lock.unlock(); suspended.signal() }
    func returned(_ number: Int) {
        guard holdFirst, number == 1 else { return }
        lock.lock(); firstReturned = true; lock.unlock(); managerReturned.signal()
    }
    func releaseHeld() {
        lock.lock(); let value = continuation; continuation = nil; lock.unlock()
        guard let value else { return }
        do { value.resume(returning: try pixels(width: 800, height: 600)) } catch { value.resume(throwing: error) }
    }
    func reset(screens: [NSScreen], holdFirst: Bool = false, pngBytes: Int? = nil) {
        lock.lock(); grabs = []; exclusions = []; cursors = 0; encodes = 0; enumerations = 0; windowLists = 0; sources = 0; firstReturned = false; firstGrabAt = nil; pngFailures = 0; lock.unlock()
        self.screens = screens; self.holdFirst = holdFirst; self.pngBytes = pngBytes; self.failingDisplay = nil; self.windowListAvailable = true
    }
    var observation: (grabs: [CGDirectDisplayID], exclusions: [[UInt32]], cursors: Int, encodes: Int, enumerations: Int, firstReturned: Bool, firstGrabAt: Double?) {
        lock.lock(); defer { lock.unlock() }
        return (grabs, exclusions, cursors, encodes, enumerations, firstReturned, firstGrabAt)
    }
}

private func hasBoundedTiming(_ value: Any?, keys: [String]) -> Bool {
    guard let timing = value as? [String: Any], Set(timing.keys) == Set(keys) else { return false }
    return keys.allSatisfy { key in
        guard let milliseconds = (timing[key] as? NSNumber)?.doubleValue else { return false }
        return milliseconds.isFinite && milliseconds >= 0 && milliseconds <= 150_000
    }
}

private func serializedDisplayResult(_ result: [String: Any]) -> [String: Any] {
    // The controlled response is only a few KiB, so the real blocking socket writer
    // cannot fill this pipe before the fixture reads it. No pixel fixture is retained.
    var descriptors: [Int32] = [-1, -1]
    precondition(pipe(&descriptors) == 0)
    let response: [String: Any] = ["id": 1, "instanceId": "fixture-instance", "ok": true, "result": result]
    writeJSON(response, to: descriptors[1])
    close(descriptors[1])
    let data = FileHandle(fileDescriptor: descriptors[0]).readDataToEndOfFile()
    close(descriptors[0])
    let envelope = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    guard envelope["ok"] as? Bool == true, envelope["id"] as? Int == 1,
          envelope["instanceId"] as? String == "fixture-instance" else { return [:] }
    return envelope["result"] as? [String: Any] ?? [:]
}

private func timingMilliseconds(_ entry: [String: Any], _ key: String) -> Double? {
    ((entry["timing"] as? [String: Any])?[key] as? NSNumber)?.doubleValue
}

@main
private struct DisplayFramesChecks {
    static func main() {
#if FORCE_CORE_GRAPHICS
        legacyMain()
#else
        modernMain()
#endif
    }

    static func modernMain() {
        guard #available(macOS 14.0, *) else {
            print("{\"environmentError\":\"The production ScreenCaptureKit branch requires macOS 14 or newer\"}")
            exit(2)
        }
        var cases: [String] = [], failures: [String] = []
        func check(_ name: String, _ value: @autoclosure () -> Bool) { cases.append(name); if !value() { failures.append(name) } }
        func code(_ error: Error?) -> String? { if case let ProviderError.coded(code, _)? = error { return code }; return nil }
        func run(_ params: [String: JSONValue] = [:]) -> (result: [String: Any]?, error: Error?) {
            do { return (try displayRequest(params), nil) } catch { return (nil, error) }
        }
        let io = Controlled.shared
        // Display 1 has a camera housing 32 points tall at its top.
        let all = [NSScreen(id: 1, backingScaleFactor: 2, safeAreaInsets: NSEdgeInsets(top: 32, left: 0, bottom: 0, right: 0)), NSScreen(id: 2, backingScaleFactor: 1),
            NSScreen(id: 3, backingScaleFactor: 1), NSScreen(id: 4, backingScaleFactor: 1)]

        io.reset(screens: all)
        let before = Date().timeIntervalSince1970 * 1000
        let (frames, error) = run()
        let displays = frames?["displays"] as? [[String: Any]] ?? []
        func entry(_ id: CGDirectDisplayID) -> [String: Any] { displays.first { $0["displayId"] as? CGDirectDisplayID == id } ?? [:] }
        check("native timing covers content, window list, total and every display's capture, PNG, base64 and total",
            hasBoundedTiming(frames?["timing"], keys: ["contentMs", "windowListMs", "totalMs"])
                && [1, 2, 3, 4].allSatisfy { hasBoundedTiming(entry($0)["timing"], keys: ["captureMs", "pngMs", "base64Ms", "totalMs"]) })
        let wireResult = serializedDisplayResult(frames ?? [:])
        let wireDisplays = wireResult["displays"] as? [[String: Any]] ?? []
        check("native response serialization is measured once on the real write path without re-encoding pixels",
            hasBoundedTiming(wireResult["timing"], keys: ["contentMs", "windowListMs", "responseSerializationMs", "totalMs"])
                && (timingMilliseconds(wireResult, "responseSerializationMs") ?? 0) > 0
                && wireDisplays.count == displays.count && wireDisplays.first?["png"] as? String == displays.first?["png"] as? String)
        check("returns a captured receipt for an all-display grab", error == nil && frames?["state"] as? String == "captured")
        check("capturedAt is taken before the first grab", (frames?["capturedAt"] as? Double).map { capturedAt in
            io.observation.firstGrabAt.map { capturedAt >= before && capturedAt <= $0 } ?? false } == true)
        check("one entry for every active display in OS order", displays.compactMap { $0["displayId"] as? CGDirectDisplayID } == [1, 2, 3, 4])
        check("exactly one physical grab per display ScreenCaptureKit lists with its bounds", io.observation.grabs == [1, 2])
        check("one window enumeration serves every display's grab", io.observation.enumerations == 1)
        check("grabs never include the cursor", io.observation.cursors == 0)
        check("frames are global Quartz points including negative origins", entry(2)["frame"] as? [String: Double] == ["x": -200, "y": -50, "width": 200, "height": 100])
        check("pixels follow each display's own scale", entry(1)["width"] as? Int == 800 && entry(1)["height"] as? Int == 600
            && entry(2)["width"] as? Int == 200 && entry(2)["height"] as? Int == 100 && entry(1)["scale"] as? CGFloat == 2)
        check("each display reports the band its camera housing covers at the top, zero without one",
            entry(1)["safeTop"] as? CGFloat == 32 && entry(2)["safeTop"] as? CGFloat == 0 && entry(3)["safeTop"] as? CGFloat == 0)
        check("captured displays carry PNG and engine and no issue", entry(1)["png"] is String && entry(1)["engine"] as? String == "screenCaptureKit" && entry(1)["issue"] == nil)
        check("a display that cannot be captured carries its issue and no pixels", (entry(3)["issue"] as? String)?.hasPrefix("display_not_found:") == true
            && entry(3)["png"] == nil && entry(3)["width"] == nil && entry(3)["engine"] == nil)
        check("a display whose bounds changed since enumeration carries its issue and no pixels",
            (entry(4)["issue"] as? String)?.hasPrefix("display_configuration_changed:") == true && entry(4)["png"] == nil && entry(4)["width"] == nil)
        check("a failed display keeps its identity and geometry", entry(3)["frame"] as? [String: Double] == ["x": 400, "y": 0, "width": 100, "height": 100] && entry(3)["scale"] as? CGFloat == 1)
        check("only captured displays are encoded", io.observation.encodes == 2)
        func windows(_ id: CGDirectDisplayID) -> [[String: Any]]? { entry(id)["windows"] as? [[String: Any]] }
        func windowIds(_ id: CGDirectDisplayID) -> [UInt32]? { windows(id)?.compactMap { $0["windowId"] as? UInt32 } }
        let listed = Set([1, 2, 3, 4].flatMap { windowIds($0) ?? [] })
        check("each display lists the normal windows over it front to back", windowIds(1) == [11, 15, 18])
        check("a window across displays is listed on each with its global frame and owner", windows(2).map { $0.count == 1
            && $0[0]["windowId"] as? UInt32 == 15 && $0[0]["frame"] as? [String: Double] == ["x": -150, "y": -40, "width": 300, "height": 120]
            && $0[0]["owner"] as? String == "Browser" } == true)
        check("a display no window covers lists none, even when its pixels failed", windowIds(3) == [] && windowIds(4) == [])
        check("the helper's own windows are not capture content", !listed.contains(12))
        check("the host's windows are not capture content", !listed.contains(13))
        check("only normal-layer windows are listed", !listed.contains(14))
        check("a window on no display is not listed", !listed.contains(16))
        check("windows absent from the pixels are not listed", !listed.contains(17) && !listed.contains(19))
        check("one window list serves every display", io.windowListings == 1)

        io.reset(screens: all)
        let included = run(["includeHostWindows": .bool(true)])
        let includedDisplays = included.result?["displays"] as? [[String: Any]] ?? []
        let includedMain = includedDisplays.first { $0["displayId"] as? CGDirectDisplayID == 1 }
        let includedIds = (includedMain?["windows"] as? [[String: Any]])?.compactMap { $0["windowId"] as? UInt32 }
        check("the included background lists the host's visible windows in place", included.error == nil && includedIds == [11, 13, 15, 18])
        check("the included background still excludes the helper's windows", includedIds.map { !$0.contains(12) } == true)
        check("including host windows still grabs and lists each display only once", io.observation.grabs == [1, 2] && io.windowListings == 1 && io.observation.enumerations == 1)
        check("included pixels exclude every helper window and no host or other-PID window",
            io.observation.exclusions == [[12, 21], [12, 21]])
        check("included pixel filtering includes helper panels without adding panels to normal-layer metadata",
            includedIds.map { !$0.contains(20) && !$0.contains(21) && !$0.contains(22) } == true)
        io.reset(screens: all)
        let excluded = run(["includeHostWindows": .bool(false)])
        let excludedDisplays = excluded.result?["displays"] as? [[String: Any]] ?? []
        let excludedIds = excludedDisplays.flatMap { ($0["windows"] as? [[String: Any]] ?? []).compactMap { $0["windowId"] as? UInt32 } }
        check("the explicit excluded background keeps the host out", excluded.error == nil && !excludedIds.contains(13))
        check("excluded pixels remove helper and every capturable host window by PID, including panels, and no other PID",
            io.observation.exclusions == [[12, 13, 20, 21], [12, 13, 20, 21]])
        check("excluded normal-layer metadata matches those pixels without listing panels", !excludedIds.contains(20) && !excludedIds.contains(21) && !excludedIds.contains(22))
        io.reset(screens: all)
        let invalid = run(["includeHostWindows": .string("true")])
        check("a nonboolean host-window option is refused before a grab", code(invalid.error) == "invalid_argument" && io.observation.grabs.isEmpty && io.windowListings == 0)

        // Each encoded PNG alone fits the frame; together they do not.
        io.reset(screens: [NSScreen(id: 1, backingScaleFactor: 2), NSScreen(id: 2, backingScaleFactor: 1)], pngBytes: 10 * 1024 * 1024)
        let large = run()
        let largeDisplays = large.result?["displays"] as? [[String: Any]] ?? []
        check("a display whose pixels overflow the response frame carries its own issue", largeDisplays.count == 2
            && largeDisplays[0]["png"] is String && (largeDisplays[1]["issue"] as? String)?.hasPrefix("image_too_large:") == true
            && largeDisplays[1]["png"] == nil && largeDisplays[1]["width"] == nil)
        let envelope: [String: Any] = ["id": Int(Int32.max), "instanceId": UUID().uuidString, "operationId": UUID().uuidString, "ok": true, "result": large.result ?? [:]]
        check("the whole response fits one NDJSON frame", (try? JSONSerialization.data(withJSONObject: envelope, options: [.withoutEscapingSlashes]))
            .map { $0.count <= NativeNDJSONReader.maxFrameBytes } == true)

        io.reset(screens: [NSScreen(id: 1, backingScaleFactor: 64), NSScreen(id: 2, backingScaleFactor: 1)])
        let oversized = run()
        let oversizedDisplays = oversized.result?["displays"] as? [[String: Any]] ?? []
        check("a display past the host image limits carries image_too_large and is never grabbed", oversizedDisplays.count == 2
            && (oversizedDisplays[0]["issue"] as? String)?.hasPrefix("image_too_large:") == true && oversizedDisplays[0]["png"] == nil
            && oversizedDisplays[1]["png"] is String && io.observation.grabs == [2])

        io.reset(screens: all)
        io.failingDisplay = 1
        let failedCapture = run()
        let failedCaptureDisplay = (failedCapture.result?["displays"] as? [[String: Any]] ?? []).first { $0["displayId"] as? CGDirectDisplayID == 1 } ?? [:]
        check("a failed capture records the time it actually spent", (failedCaptureDisplay["issue"] as? String)?.hasPrefix("controlled_capture_failed:") == true
            && (timingMilliseconds(failedCaptureDisplay, "captureMs") ?? 0) >= 4
            && timingMilliseconds(failedCaptureDisplay, "pngMs") == 0
            && (timingMilliseconds(failedCaptureDisplay, "totalMs") ?? 0) >= (timingMilliseconds(failedCaptureDisplay, "captureMs") ?? .infinity))

        io.reset(screens: all)
        io.failNextPNG()
        let failedPNG = run()
        let failedPNGDisplay = (failedPNG.result?["displays"] as? [[String: Any]] ?? []).first { $0["displayId"] as? CGDirectDisplayID == 1 } ?? [:]
        check("a failed PNG encode records the time it actually spent", (failedPNGDisplay["issue"] as? String)?.hasPrefix("controlled_png_failed:") == true
            && (timingMilliseconds(failedPNGDisplay, "captureMs") ?? 0) >= 4
            && (timingMilliseconds(failedPNGDisplay, "pngMs") ?? 0) >= 4
            && (timingMilliseconds(failedPNGDisplay, "totalMs") ?? 0) >= (timingMilliseconds(failedPNGDisplay, "pngMs") ?? .infinity))

        io.reset(screens: [NSScreen(id: 3, backingScaleFactor: 1)])
        let none = run()
        check("no captured display is a typed failure, not an empty success", none.result == nil && code(none.error) == "display_capture_unavailable")

        io.reset(screens: [])
        let empty = run()
        check("no active display is a typed failure", empty.result == nil && code(empty.error) == "display_not_found")

        io.reset(screens: [NSScreen(id: 1, backingScaleFactor: 1)], holdFirst: true)
        let started = Date()
        let timedOut = run()
        let elapsed = Date().timeIntervalSince(started)
        check("a held producer times out with the production ten-second observer",
            elapsed >= 9 && timedOut.result == nil && code(timedOut.error) == "display_capture_unavailable")
        check("the held producer is still running after its observer returned", io.suspended.wait(timeout: .now() + 1) == .success && !io.observation.firstReturned)
        let busy = run()
        check("a second capture is busy while the first producer still owns the display", code(busy.error) == "capture_busy")
        check("the busy capture never starts another physical grab", io.observation.grabs == [1])
        io.releaseHeld()
        check("the held producer returns after release", io.managerReturned.wait(timeout: .now() + 5) == .success)
        let deadline = Date().addingTimeInterval(5)
        var released = false
        repeat {
            do { released = try NativeDisplayCaptureLease.shared.withCapture { _ in true } }
            catch NativeDisplayCaptureLease.Failure.busy { Thread.sleep(forTimeInterval: 0.001) }
            catch { break }
        } while !released && Date() < deadline
        check("ownership is released only after the producer actually returned", released)
        io.reset(screens: [NSScreen(id: 1, backingScaleFactor: 1)])
        check("the next capture succeeds after release", run().result?["state"] as? String == "captured")

        io.reset(screens: all)
        let selection = NativeDesktopOperations.capture(["mode": .string("selection")])
        check("selection is an unknown native mode and starts no capture", selection["state"] as? String == "failed"
            && (selection["error"] as? [String: String])?["code"] == "invalid_argument" && io.observation.grabs.isEmpty && io.sources == 0)
        _ = NativeDesktopOperations.capture(["mode": .string("display"), "displayId": .number(1)])
        check("an exact display source still reaches its grab", io.sources == 1)

        let report: [String: Any] = ["schema": "agentmux.display-frames-checks.v1", "tests": cases.count, "cases": cases, "failures": failures,
            "boundary": "Exact production capture dispatch, captureDisplays/displayPixels/BlockingAsync source and Core lease; controlled display list, ScreenCaptureKit service, PNG encoder and exact-source grabs. No WindowServer pixels, TCC prompt or installed-app proof."]
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        if cases.isEmpty || !failures.isEmpty { exit(1) }
    }

    static func legacyMain() {
        var cases: [String] = [], failures: [String] = []
        func check(_ name: String, _ value: @autoclosure () -> Bool) { cases.append(name); if !value() { failures.append(name) } }
        func code(_ error: Error?) -> String? { if case let ProviderError.coded(code, _)? = error { return code }; return nil }
        func run(_ includeHostWindows: Bool) -> (result: [String: Any]?, error: Error?) {
            do { return (try displayRequest(["includeHostWindows": .bool(includeHostWindows)]), nil) } catch { return (nil, error) }
        }
        let io = Controlled.shared
        let screens = [NSScreen(id: 1, backingScaleFactor: 1), NSScreen(id: 2, backingScaleFactor: 1)]
        func display(_ result: [String: Any]?, _ id: CGDirectDisplayID) -> [String: Any] {
            (result?["displays"] as? [[String: Any]] ?? []).first { $0["displayId"] as? CGDirectDisplayID == id } ?? [:]
        }

        io.reset(screens: screens)
        let included = run(true)
        check("forced CoreGraphics inclusion captures the visible host normally", included.error == nil
            && display(included.result, 1)["png"] is String && display(included.result, 1)["engine"] as? String == "coreGraphics"
            && ((display(included.result, 1)["windows"] as? [[String: Any]] ?? []).contains { $0["windowId"] as? UInt32 == 13 }))
        check("forced CoreGraphics inclusion keeps its native and per-display timing", hasBoundedTiming(included.result?["timing"], keys: ["contentMs", "windowListMs", "totalMs"])
            && hasBoundedTiming(display(included.result, 1)["timing"], keys: ["captureMs", "pngMs", "base64Ms", "totalMs"]))

        io.reset(screens: screens)
        let excluded = run(false)
        let hostDisplay = display(excluded.result, 1), otherDisplay = display(excluded.result, 2)
        check("forced CoreGraphics exclusion refuses only the display containing the visible host", excluded.error == nil
            && (hostDisplay["issue"] as? String)?.hasPrefix("host_window_exclusion_unavailable:") == true
            && hostDisplay["png"] == nil && hostDisplay["engine"] == nil)
        check("forced CoreGraphics exclusion leaves a display without the host usable", otherDisplay["png"] is String
            && otherDisplay["engine"] as? String == "coreGraphics" && otherDisplay["issue"] == nil && io.observation.grabs == [2])
        check("forced CoreGraphics exclusion reports bounded timing for refused and captured displays",
            hasBoundedTiming(hostDisplay["timing"], keys: ["captureMs", "pngMs", "base64Ms", "totalMs"])
                && hasBoundedTiming(otherDisplay["timing"], keys: ["captureMs", "pngMs", "base64Ms", "totalMs"]))

        io.reset(screens: [NSScreen(id: 2, backingScaleFactor: 1)])
        let noHost = run(false)
        check("forced CoreGraphics exclusion captures normally when no host window is visible", noHost.error == nil
            && display(noHost.result, 2)["png"] is String && display(noHost.result, 2)["issue"] == nil && io.observation.grabs == [2])

        io.reset(screens: screens)
        io.windowListAvailable = false
        let unknownIncluded = run(true)
        check("forced CoreGraphics inclusion still captures when window metadata is unavailable", unknownIncluded.error == nil
            && display(unknownIncluded.result, 1)["png"] is String && display(unknownIncluded.result, 2)["png"] is String && io.observation.grabs == [1, 2])

        io.reset(screens: screens)
        io.windowListAvailable = false
        let unknownExcluded = run(false)
        check("forced CoreGraphics exclusion is typed unavailable when host visibility is unknown", unknownExcluded.result == nil
            && code(unknownExcluded.error) == "window_list_unavailable" && io.observation.grabs.isEmpty)

        let report: [String: Any] = ["schema": "agentmux.display-frames-checks.v1", "tests": cases.count, "cases": cases, "failures": failures,
            "engine": "forced-coreGraphics", "boundary": "Exact production captureDisplays with its macOS 14 availability branch forced off; controlled CoreGraphics pixels and window server. No real macOS 12/13 device claim."]
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        if cases.isEmpty || !failures.isEmpty { exit(1) }
    }
}
