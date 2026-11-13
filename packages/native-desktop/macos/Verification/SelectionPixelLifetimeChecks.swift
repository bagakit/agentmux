import Foundation
import CoreGraphics
import AgentMuxNativeMacOSCore

// Exact production dispatch, frozen display/SCK, rectangle and permission
// methods are inserted. Only the external OS producer and chooser are controlled.
private enum NativeDesktopOperations {
    /* PRODUCTION_CAPTURE_METHODS */
    /* PRODUCTION_FROZEN_METHODS */
    /* PRODUCTION_RECTANGLE_METHODS */
    /* PRODUCTION_PERMISSION_QUERY */
    static func png(_ image: CGImage, scale: Double) throws -> [String: Any] {
        ControlledPixels.shared.encoded()
        return ["format": "png", "data": "controlled-png", "scale": scale]
    }
    static func displayScale(for rect: CGRect) -> Double { 1 }
    static func renderRect(_ rect: CGRect) -> [String: Double] { ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height] }
    static func captureWindow(_ params: [String: JSONValue]) throws -> [String: Any] { throw ProviderError.coded("fixture_scope", "window IO is not selected") }
    static func displayIDArgument(_ value: JSONValue?) throws -> CGDirectDisplayID { throw ProviderError.coded("fixture_scope", "display IO is not selected") }
}

/* PRODUCTION_BLOCKING_ASYNC */

private enum JSONValue {
    case string(String), number(Double), bool(Bool), object([String: JSONValue])
    var string: String? { if case let .string(value) = self { return value }; return nil }
    var number: Double? { if case let .number(value) = self { return value }; return nil }
    var bool: Bool? { if case let .bool(value) = self { return value }; return nil }
}
private enum ProviderError: Error { case coded(String, String) }
struct NativeScreenSelectionError: Error { let code: String; let message: String }
private func nativeErrorPayload(_ error: Error) -> [String: String] {
    if case let ProviderError.coded(code, message) = error { return ["code": code, "message": message] }
    if let error = error as? NativeScreenSelectionError { return ["code": error.code, "message": error.message] }
    return ["code": "fixture_unexpected", "message": String(describing: error)]
}
private enum NativeSelectionCompletionAction: String { case capture, edit }
private struct NativeSelectionChoice { let rectangle: CGRect; let completionAction: NativeSelectionCompletionAction; let pixels: NativeSelectionPixels }
private enum NativeSelectionRequest {
    static func run(allowEditing: Bool = false,
        load: @escaping @Sendable (NativeSelectionLoading) throws -> NativeSelectionPixels) throws -> NativeSelectionChoice? {
        ControlledPixels.shared.selected()
        let pixels = try load(NativeSelectionLoading())
        guard pixels.displays.contains(where: { $0.image != nil }) else {
            throw NativeScreenSelectionError(code: "display_capture_unavailable", message: pixels.displays.compactMap(\.issue).joined(separator: "\n"))
        }
        return NativeSelectionChoice(rectangle: CGRect(x: 10, y: 20, width: 100, height: 80), completionAction: .capture, pixels: pixels)
    }
}
private func onMain<T>(_ body: () throws -> T) rethrows -> T { try body() }
private func CGDisplayBounds(_ display: CGDirectDisplayID) -> CGRect { CGRect(x: 0, y: 0, width: 400, height: 300) }
private struct NSDeviceDescriptionKey: Hashable { let rawValue: String; init(_ value: String) { rawValue = value } }
private struct NSScreen {
    let frame = CGRect(x: 0, y: 0, width: 400, height: 300)
    let backingScaleFactor: CGFloat = 1
    let deviceDescription: [NSDeviceDescriptionKey: Any] = [NSDeviceDescriptionKey("NSScreenNumber"): NSNumber(value: 1)]
    static var screens: [NSScreen] { [NSScreen()] }
}

// These names replace ScreenCaptureKit's external service, not the production
// caller or asynchronous lifetime. The first request deliberately ignores Task
// cancellation until this fixture resumes its checked continuation.
private struct SCDisplay: Sendable { let displayID: CGDirectDisplayID = 1; let frame = CGRect(x: 0, y: 0, width: 400, height: 300) }
private struct SCApplication: Sendable { let processID: pid_t }
private struct SCWindow: Sendable { let owningApplication: SCApplication? }
private struct SCShareableContent: Sendable {
    let displays = [SCDisplay()]
    let windows: [SCWindow] = []
    static var current: SCShareableContent { get async throws { SCShareableContent() } }
}
private final class SCContentFilter: @unchecked Sendable {
    init(display: SCDisplay, excludingWindows: [SCWindow]) {}
}
private final class SCStreamConfiguration: @unchecked Sendable {
    var sourceRect = CGRect.zero
    var width = 0, height = 0
    var showsCursor = false
}
private enum SCScreenshotManager {
    static func captureImage(contentFilter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
        let number = ControlledPixels.shared.started()
        defer { ControlledPixels.shared.returned(number) }
        if number == 1 { return try await withCheckedThrowingContinuation { ControlledPixels.shared.suspend($0) } }
        return try pixel()
    }
}
private func pixel() throws -> CGImage {
    guard let context = CGContext(data: nil, width: 400, height: 300, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
        let image = context.makeImage() else { throw ProviderError.coded("fixture_allocation", "could not create controlled pixels") }
    return image
}
private func AXIsProcessTrusted() -> Bool { ControlledPixels.shared.queried(); return false }
private func CGPreflightScreenCaptureAccess() -> Bool { false }

private final class ControlledPixels: @unchecked Sendable {
    static let shared = ControlledPixels()
    let suspended = DispatchSemaphore(value: 0), managerReturned = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CGImage, Error>?
    private var selectors = 0, producers = 0, encodes = 0, queries = 0
    private var resumed = false, firstReturned = false
    func selected() { lock.lock(); selectors += 1; lock.unlock() }
    func started() -> Int { lock.lock(); defer { lock.unlock() }; producers += 1; return producers }
    func encoded() { lock.lock(); encodes += 1; lock.unlock() }
    func queried() { lock.lock(); queries += 1; lock.unlock() }
    func suspend(_ value: CheckedContinuation<CGImage, Error>) {
        lock.lock(); continuation = value; lock.unlock(); suspended.signal()
    }
    func returned(_ number: Int) {
        guard number == 1 else { return }
        lock.lock(); firstReturned = true; lock.unlock(); managerReturned.signal()
    }
    func releaseProducer() {
        lock.lock(); let value = continuation; continuation = nil; resumed = true; lock.unlock()
        guard let value else { return }
        do { value.resume(returning: try pixel()) } catch { value.resume(throwing: error) }
    }
    func observation() -> [String: Int] {
        lock.lock(); defer { lock.unlock() }
        return ["selectors": selectors, "producers": producers, "encodes": encodes, "queries": queries,
            "resumeRequested": resumed ? 1 : 0, "firstManagerReturned": firstReturned ? 1 : 0]
    }
}

@main
private struct SelectionPixelLifetimeChecks {
    static func main() {
        guard #available(macOS 14.0, *) else {
            print("{\"environmentError\":\"The exact production SCK branch requires macOS 14 or newer\"}")
            exit(2)
        }
        var cases: [String] = [], failures: [String] = []
        func check(_ name: String, _ value: @autoclosure () -> Bool) { cases.append(name); if !value() { failures.append(name) } }
        func errorCode(_ result: [String: Any]) -> String? { (result["error"] as? [String: String])?["code"] }
        let io = ControlledPixels.shared
        let startedAt = ProcessInfo.processInfo.systemUptime
        let first = NativeDesktopOperations.capture(["mode": .string("selection")])
        let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
        check("A retains the original failed display and native timeout detail", first["state"] as? String == "failed" && errorCode(first) == "display_capture_unavailable" && ((first["error"] as? [String: String])?["message"]?.contains("action_timeout") == true))
        check("A uses the unchanged ten-second production observer deadline", elapsed >= 9)
        check("A pixel producer is suspended after its observer timed out", io.suspended.wait(timeout: .now() + 1) == .success && io.observation()["firstManagerReturned"] == 0 && io.observation()["resumeRequested"] == 0)
        let afterTimeout = io.observation()
        let second = NativeDesktopOperations.capture(["mode": .string("selection")])
        check("B returns capture_busy until A physical pixel producer exits", second["state"] as? String == "failed" && errorCode(second) == "capture_busy")
        check("B cannot open a second selector after A observer timeout", io.observation()["selectors"] == 1)
        check("B cannot start another pixel producer after A observer timeout", io.observation()["producers"] == 1)
        let queryFinished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { _ = NativeDesktopOperations.permissionStatus(); queryFinished.signal() }
        check("unrelated actual permission query remains available during held pixels", queryFinished.wait(timeout: .now() + 1) == .success && io.observation()["queries"] == 1)
        let beforeRelease = io.observation()
        check("no screenshot success is encoded for timed-out A or rejected B", beforeRelease["encodes"] == 0)
        io.releaseProducer()
        check("the non-cooperative pixel service actually returns after explicit release", io.managerReturned.wait(timeout: .now() + 5) == .success)
        let releaseDeadline = ProcessInfo.processInfo.systemUptime + 5
        var released = false
        repeat {
            do { released = try NativeSelectionCaptureLease.shared.withCapture { _ in true } }
            catch NativeSelectionCaptureLease.Failure.busy { Thread.sleep(forTimeInterval: 0.001) }
            catch { break }
        } while !released && ProcessInfo.processInfo.systemUptime < releaseDeadline
        check("A production closure releases physical ownership after actual return", released)
        let third = NativeDesktopOperations.capture(["mode": .string("selection")])
        check("C captures normally after A actual physical ownership releases", third["state"] as? String == "captured")
        check("only A and C invoke selectors and pixel producers", io.observation()["selectors"] == 2 && io.observation()["producers"] == 2)
        let report: [String: Any] = ["schema": "agentmux.selection-pixel-lifetime-checks.v1", "tests": cases.count, "cases": cases, "failures": failures,
            "firstState": first["state"] as? String ?? "missing", "firstCode": errorCode(first) ?? "missing",
            "secondState": second["state"] as? String ?? "missing", "secondCode": errorCode(second) ?? "missing",
            "thirdState": third["state"] as? String ?? "missing", "observerSeconds": elapsed,
            "afterTimeout": afterTimeout, "beforeRelease": beforeRelease, "afterRelease": io.observation(),
            "boundary": "Exact production capture/frozen SCK/BlockingAsync source and Core ownership; controlled chooser, display descriptors, non-cooperative SCK service, permission OS queries and PNG IO. No AppKit, screen capture, UI, focus, permission prompt or installed-app proof."]
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        if cases.isEmpty || !failures.isEmpty { exit(1) }
    }
}
