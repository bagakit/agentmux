import Foundation
import CoreGraphics
import AgentMuxNativeMacOSCore

// The exact production captureDisplays/displayPixels and BlockingAsync source
// is inserted. Only the OS display list, ScreenCaptureKit and PNG encoding are
// controlled, so each display's grab, issue and ownership are observable.
private enum NativeDesktopOperations {
    /* PRODUCTION_DISPLAY_FRAMES */
    static func pngData(_ image: CGImage) throws -> Data { Controlled.shared.encoded(); return Data("png-\(image.width)x\(image.height)".utf8) }
    static func renderRect(_ rect: CGRect) -> [String: Double] { ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height] }
}

/* PRODUCTION_BLOCKING_ASYNC */

private enum ProviderError: Error { case coded(String, String) }
private struct CapturedImage { let image: CGImage; let engine: String }
private func nativeErrorPayload(_ error: Error) -> [String: String] {
    if case let ProviderError.coded(code, message) = error { return ["code": code, "message": message] }
    return ["code": "fixture_unexpected", "message": String(describing: error)]
}
private func onMain<T>(_ body: () throws -> T) rethrows -> T { try body() }

// Display 1 is the 2x main display, display 2 a 1x display to its left (negative
// Quartz origin), display 3 one ScreenCaptureKit no longer lists.
private let bounds: [CGDirectDisplayID: CGRect] = [
    1: CGRect(x: 0, y: 0, width: 400, height: 300),
    2: CGRect(x: -200, y: -50, width: 200, height: 100),
    3: CGRect(x: 400, y: 0, width: 100, height: 100),
]
private func CGDisplayBounds(_ display: CGDirectDisplayID) -> CGRect { bounds[display] ?? .null }
private func CGMainDisplayID() -> CGDirectDisplayID { 1 }
private func CGWindowListCreateImage(_ rect: CGRect, _ option: Int, _ window: Int, _ image: [Int]) -> CGImage? { nil }
private let kCGNullWindowID = 0
private extension Int { static let optionOnScreenOnly = 0, bestResolution = 0 }
private struct NSDeviceDescriptionKey: Hashable { let rawValue: String; init(_ value: String) { rawValue = value } }
private struct NSScreen {
    let id: CGDirectDisplayID?
    let backingScaleFactor: CGFloat
    var deviceDescription: [NSDeviceDescriptionKey: Any] { id.map { [NSDeviceDescriptionKey("NSScreenNumber"): NSNumber(value: $0)] } ?? [:] }
    static var screens: [NSScreen] { Controlled.shared.screens }
}

private struct SCDisplay: Sendable { let displayID: CGDirectDisplayID; let frame: CGRect }
private struct SCWindow: Sendable {}
private struct SCShareableContent: Sendable {
    let displays = [SCDisplay(displayID: 1, frame: bounds[1]!), SCDisplay(displayID: 2, frame: bounds[2]!)]
    static var current: SCShareableContent { get async throws { SCShareableContent() } }
}
private final class SCContentFilter: @unchecked Sendable {
    let displayID: CGDirectDisplayID
    init(display: SCDisplay, excludingWindows: [SCWindow]) { displayID = display.displayID }
}
private final class SCStreamConfiguration: @unchecked Sendable { var width = 0, height = 0; var showsCursor = true }
private enum SCScreenshotManager {
    static func captureImage(contentFilter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
        let number = Controlled.shared.started(contentFilter.displayID, cursor: configuration.showsCursor)
        defer { Controlled.shared.returned(number) }
        if Controlled.shared.holdFirst, number == 1 { return try await withCheckedThrowingContinuation { Controlled.shared.suspend($0) } }
        return try pixels(width: configuration.width, height: configuration.height)
    }
}
private func pixels(width: Int, height: Int) throws -> CGImage {
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
    private var grabs: [CGDirectDisplayID] = [], cursors = 0, encodes = 0, firstReturned = false
    var screens: [NSScreen] = []
    var holdFirst = false
    func started(_ id: CGDirectDisplayID, cursor: Bool) -> Int {
        lock.lock(); defer { lock.unlock() }
        grabs.append(id); if cursor { cursors += 1 }
        return grabs.count
    }
    func encoded() { lock.lock(); encodes += 1; lock.unlock() }
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
    func reset(screens: [NSScreen], holdFirst: Bool = false) {
        lock.lock(); grabs = []; cursors = 0; encodes = 0; firstReturned = false; lock.unlock()
        self.screens = screens; self.holdFirst = holdFirst
    }
    var observation: (grabs: [CGDirectDisplayID], cursors: Int, encodes: Int, firstReturned: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (grabs, cursors, encodes, firstReturned)
    }
}

@main
private struct DisplayFramesChecks {
    static func main() {
        guard #available(macOS 14.0, *) else {
            print("{\"environmentError\":\"The production ScreenCaptureKit branch requires macOS 14 or newer\"}")
            exit(2)
        }
        var cases: [String] = [], failures: [String] = []
        func check(_ name: String, _ value: @autoclosure () -> Bool) { cases.append(name); if !value() { failures.append(name) } }
        func code(_ error: Error?) -> String? { if case let ProviderError.coded(code, _)? = error { return code }; return nil }
        func run() -> (result: [String: Any]?, error: Error?) {
            do { return (try NativeDesktopOperations.captureDisplays(), nil) } catch { return (nil, error) }
        }
        let io = Controlled.shared
        let all = [NSScreen(id: 1, backingScaleFactor: 2), NSScreen(id: 2, backingScaleFactor: 1), NSScreen(id: 3, backingScaleFactor: 1)]

        io.reset(screens: all)
        let before = Date().timeIntervalSince1970 * 1000
        let (frames, error) = run()
        let displays = frames?["displays"] as? [[String: Any]] ?? []
        func entry(_ id: CGDirectDisplayID) -> [String: Any] { displays.first { $0["displayId"] as? CGDirectDisplayID == id } ?? [:] }
        check("returns a captured receipt for an all-display grab", error == nil && frames?["state"] as? String == "captured")
        check("capturedAt is taken before the grabs", (frames?["capturedAt"] as? Double).map { $0 >= before && $0 <= Date().timeIntervalSince1970 * 1000 } == true)
        check("one entry for every active display in OS order", displays.compactMap { $0["displayId"] as? CGDirectDisplayID } == [1, 2, 3])
        check("exactly one physical grab per display ScreenCaptureKit lists", io.observation.grabs == [1, 2])
        check("grabs never include the cursor", io.observation.cursors == 0)
        check("frames are global Quartz points including negative origins", entry(2)["frame"] as? [String: Double] == ["x": -200, "y": -50, "width": 200, "height": 100])
        check("main display is the OS main display only", entry(1)["isMain"] as? Bool == true && entry(2)["isMain"] as? Bool == false)
        check("pixels follow each display's own scale", entry(1)["width"] as? Int == 800 && entry(1)["height"] as? Int == 600
            && entry(2)["width"] as? Int == 200 && entry(2)["height"] as? Int == 100 && entry(1)["scale"] as? CGFloat == 2)
        check("captured displays carry PNG and engine and no issue", entry(1)["png"] is String && entry(1)["engine"] as? String == "screenCaptureKit" && entry(1)["issue"] == nil)
        check("a display that cannot be captured carries its issue and no pixels", (entry(3)["issue"] as? String)?.hasPrefix("display_not_found:") == true
            && entry(3)["png"] == nil && entry(3)["width"] == nil && entry(3)["engine"] == nil)
        check("a failed display keeps its identity and geometry", entry(3)["frame"] as? [String: Double] == ["x": 400, "y": 0, "width": 100, "height": 100] && entry(3)["scale"] as? CGFloat == 1)
        check("only captured displays are encoded", io.observation.encodes == 2)

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

        let report: [String: Any] = ["schema": "agentmux.display-frames-checks.v1", "tests": cases.count, "cases": cases, "failures": failures,
            "boundary": "Exact production captureDisplays/displayPixels/BlockingAsync source and Core lease; controlled display list, ScreenCaptureKit service and PNG encoder. No WindowServer pixels, TCC prompt or installed-app proof."]
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        if cases.isEmpty || !failures.isEmpty { exit(1) }
    }
}
